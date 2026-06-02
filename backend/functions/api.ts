import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { hasPermission, extractUserFromEvent, User } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

interface APIGatewayEvent {
  httpMethod: string;
  path: string;
  pathParameters?: { [key: string]: string };
  queryStringParameters?: { [key: string]: string };
  body?: string;
  headers?: { [key: string]: string };
}

interface APIGatewayResponse {
  statusCode: number;
  headers?: { [key: string]: string };
  body: string;
}

const TABLE_CONFIGS = {
  '0': { name: 'stores', pk: 'STORE' },
  '1': { name: 'keep_bottle_inventory', pk: 'KEEP_BOTTLE' },
  '2': { name: 'member_visit_history', pk: 'VISIT_HISTORY' },
  '3': { name: 'keep_bottle_consumption_history', pk: 'CONSUMPTION_HISTORY' },
  '4': { name: 'demand_forecast_reports', pk: 'DEMAND_FORECAST' },
  '5': { name: 'monthly_summary_data', pk: 'MONTHLY_SUMMARY' },
  '6': { name: 'seasonal_analysis_data', pk: 'SEASONAL_ANALYSIS' },
  '7': { name: 'replenishment_plans', pk: 'REPLENISHMENT_PLAN' },
  '8': { name: 'delivery_schedules', pk: 'DELIVERY_SCHEDULE' },
  '9': { name: 'delivery_routes', pk: 'DELIVERY_ROUTE' },
  '10': { name: 'system_users', pk: 'SYSTEM_USER' }
};

async function createAuditLog(user: User, action: string, resource: string, details: any) {
  const auditLog = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    userId: user.id,
    action,
    resource,
    details: JSON.stringify(details),
    timestamp: new Date().toISOString()
  };
  
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditLog
  }));
}

function validateRequired(item: any, requiredFields: string[]): string[] {
  const errors: string[] = [];
  for (const field of requiredFields) {
    if (!item[field]) {
      errors.push(`${field} is required`);
    }
  }
  return errors;
}

function createResponse(statusCode: number, body: any): APIGatewayResponse {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    },
    body: JSON.stringify(body)
  };
}

async function handleBulkImport(event: APIGatewayEvent, user: User, tableIndex: string): Promise<APIGatewayResponse> {
  if (!hasPermission(user, 'bulk', 'bulk')) {
    return createResponse(403, { error: 'Insufficient permissions for bulk import' });
  }

  const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
  if (!config) {
    return createResponse(404, { error: 'Table not found' });
  }

  let requestBody;
  try {
    requestBody = JSON.parse(event.body || '{}');
  } catch (error) {
    return createResponse(400, { error: 'Invalid JSON in request body' });
  }

  const { items } = requestBody;
  if (!Array.isArray(items)) {
    return createResponse(400, { error: 'items must be an array' });
  }

  let imported = 0;
  let failed = 0;
  const errors: string[] = [];
  const now = new Date().toISOString();

  // Process in batches of 25 (DynamoDB BatchWrite limit)
  for (let i = 0; i < items.length; i += 25) {
    const batch = items.slice(i, i + 25);
    const writeRequests = batch.map(item => {
      const enhancedItem = {
        ...item,
        pk: config.pk,
        sk: item.id || randomUUID(),
        id: item.id || randomUUID(),
        createdAt: now,
        updatedAt: now,
        createdBy: user.id,
        updatedBy: user.id
      };

      return {
        PutRequest: {
          Item: enhancedItem
        }
      };
    });

    try {
      const command = new BatchWriteCommand({
        RequestItems: {
          [TABLE_NAME]: writeRequests
        }
      });
      
      await docClient.send(command);
      imported += batch.length;
    } catch (error) {
      failed += batch.length;
      errors.push(`Batch ${Math.floor(i/25) + 1}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  await createAuditLog(user, 'BULK_IMPORT', config.name, { imported, failed, total: items.length });

  return createResponse(200, { imported, failed, errors });
}

export const handler = async (event: APIGatewayEvent): Promise<APIGatewayResponse> => {
  try {
    // Handle CORS preflight
    if (event.httpMethod === 'OPTIONS') {
      return createResponse(200, {});
    }

    // Extract user from token
    let user: User;
    try {
      user = extractUserFromEvent(event);
    } catch (error) {
      return createResponse(401, { error: 'Unauthorized' });
    }

    const path = event.path;
    const method = event.httpMethod;

    // Handle GET /resources
    if (method === 'GET' && path === '/resources') {
      if (!hasPermission(user, 'resources', 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      try {
        const resources = [];
        
        // Scan all table types
        for (const [index, config] of Object.entries(TABLE_CONFIGS)) {
          const command = new ScanCommand({
            TableName: TABLE_NAME,
            FilterExpression: 'pk = :pk',
            ExpressionAttributeValues: {
              ':pk': config.pk
            },
            Limit: 100
          });
          
          const result = await docClient.send(command);
          resources.push({
            tableIndex: index,
            tableName: config.name,
            pkType: config.pk,
            count: result.Count || 0,
            items: result.Items || []
          });
        }

        return createResponse(200, { resources });
      } catch (error) {
        console.error('Error fetching resources:', error);
        return createResponse(500, { error: 'Internal server error' });
      }
    }

    // Handle bulk import endpoints
    const bulkImportMatch = path.match(/^\/api\/(\d+)\/bulk$/);
    if (method === 'POST' && bulkImportMatch) {
      const tableIndex = bulkImportMatch[1];
      return await handleBulkImport(event, user, tableIndex);
    }

    // Handle individual table operations
    const tableMatch = path.match(/^\/api\/(\d+)(?:\/(\w+))?$/);
    if (tableMatch) {
      const tableIndex = tableMatch[1];
      const itemId = tableMatch[2];
      const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
      
      if (!config) {
        return createResponse(404, { error: 'Table not found' });
      }

      // GET /api/{tableIndex} - List items
      if (method === 'GET' && !itemId) {
        if (!hasPermission(user, config.name, 'read')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        try {
          const command = new ScanCommand({
            TableName: TABLE_NAME,
            FilterExpression: 'pk = :pk',
            ExpressionAttributeValues: {
              ':pk': config.pk
            }
          });
          
          const result = await docClient.send(command);
          return createResponse(200, { items: result.Items || [] });
        } catch (error) {
          console.error('Error listing items:', error);
          return createResponse(500, { error: 'Internal server error' });
        }
      }

      // GET /api/{tableIndex}/{id} - Get item
      if (method === 'GET' && itemId) {
        if (!hasPermission(user, config.name, 'read')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        try {
          const command = new GetCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: config.pk,
              sk: itemId
            }
          });
          
          const result = await docClient.send(command);
          if (!result.Item) {
            return createResponse(404, { error: 'Item not found' });
          }
          
          return createResponse(200, result.Item);
        } catch (error) {
          console.error('Error getting item:', error);
          return createResponse(500, { error: 'Internal server error' });
        }
      }

      // POST /api/{tableIndex} - Create item
      if (method === 'POST' && !itemId) {
        if (!hasPermission(user, config.name, 'create')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        let requestBody;
        try {
          requestBody = JSON.parse(event.body || '{}');
        } catch (error) {
          return createResponse(400, { error: 'Invalid JSON in request body' });
        }

        // Basic validation based on table type
        let validationErrors: string[] = [];
        switch (config.pk) {
          case 'STORE':
            validationErrors = validateRequired(requestBody, ['storeCode', 'storeName', 'storeCategory', 'prefecture', 'city', 'transactionStartDate', 'transactionStatus', 'isActive']);
            break;
          case 'KEEP_BOTTLE':
            validationErrors = validateRequired(requestBody, ['storeId', 'customerName', 'productName', 'category', 'capacityMl', 'remainingMl', 'remainingPercent', 'keepStartDate', 'status']);
            break;
          // Add more validation cases as needed
        }

        if (validationErrors.length > 0) {
          return createResponse(400, { error: 'Validation failed', details: validationErrors });
        }

        const now = new Date().toISOString();
        const newItem = {
          ...requestBody,
          pk: config.pk,
          sk: requestBody.id || randomUUID(),
          id: requestBody.id || randomUUID(),
          createdAt: now,
          updatedAt: now,
          createdBy: user.id,
          updatedBy: user.id
        };

        try {
          const command = new PutCommand({
            TableName: TABLE_NAME,
            Item: newItem
          });
          
          await docClient.send(command);
          await createAuditLog(user, 'CREATE', config.name, { itemId: newItem.id });
          
          return createResponse(201, newItem);
        } catch (error) {
          console.error('Error creating item:', error);
          return createResponse(500, { error: 'Internal server error' });
        }
      }

      // PUT /api/{tableIndex}/{id} - Update item
      if (method === 'PUT' && itemId) {
        if (!hasPermission(user, config.name, 'update')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        let requestBody;
        try {
          requestBody = JSON.parse(event.body || '{}');
        } catch (error) {
          return createResponse(400, { error: 'Invalid JSON in request body' });
        }

        // Check if item exists
        try {
          const getCommand = new GetCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: config.pk,
              sk: itemId
            }
          });
          
          const existingItem = await docClient.send(getCommand);
          if (!existingItem.Item) {
            return createResponse(404, { error: 'Item not found' });
          }

          const updatedItem = {
            ...existingItem.Item,
            ...requestBody,
            pk: config.pk,
            sk: itemId,
            id: itemId,
            updatedAt: new Date().toISOString(),
            updatedBy: user.id
          };

          const putCommand = new PutCommand({
            TableName: TABLE_NAME,
            Item: updatedItem
          });
          
          await docClient.send(putCommand);
          await createAuditLog(user, 'UPDATE', config.name, { itemId });
          
          return createResponse(200, updatedItem);
        } catch (error) {
          console.error('Error updating item:', error);
          return createResponse(500, { error: 'Internal server error' });
        }
      }

      // DELETE /api/{tableIndex}/{id} - Delete item
      if (method === 'DELETE' && itemId) {
        if (!hasPermission(user, config.name, 'delete')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        try {
          // Check if item exists first
          const getCommand = new GetCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: config.pk,
              sk: itemId
            }
          });
          
          const existingItem = await docClient.send(getCommand);
          if (!existingItem.Item) {
            return createResponse(404, { error: 'Item not found' });
          }

          const deleteCommand = new DeleteCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: config.pk,
              sk: itemId
            }
          });
          
          await docClient.send(deleteCommand);
          await createAuditLog(user, 'DELETE', config.name, { itemId });
          
          return createResponse(200, { message: 'Item deleted successfully' });
        } catch (error) {
          console.error('Error deleting item:', error);
          return createResponse(500, { error: 'Internal server error' });
        }
      }
    }

    return createResponse(404, { error: 'Endpoint not found' });
    
  } catch (error) {
    console.error('Unhandled error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};