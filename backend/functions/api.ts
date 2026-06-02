import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { hasPermission, extractUserFromEvent, User } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

const TABLE_CONFIGS = {
  '0': { name: 'stores', pk: 'storeId', displayName: '店舗マスタ' },
  '1': { name: 'keep_bottles', pk: 'keepBottleId', displayName: 'キープボトル在庫' },
  '2': { name: 'visit_history', pk: 'visitHistoryId', displayName: '会員来店履歴' },
  '3': { name: 'consumption_history', pk: 'consumptionHistoryId', displayName: 'キープボトル消費履歴' },
  '4': { name: 'demand_forecast', pk: 'forecastReportId', displayName: '需要予測レポート' },
  '5': { name: 'monthly_summary', pk: 'summaryId', displayName: '月次集計データ' },
  '6': { name: 'seasonal_analysis', pk: 'seasonalAnalysisId', displayName: '季節変動分析データ' },
  '7': { name: 'replenishment_plan', pk: 'replenishmentPlanId', displayName: '補充計画' },
  '8': { name: 'delivery_schedule', pk: 'deliveryScheduleId', displayName: '納品スケジュール' },
  '9': { name: 'delivery_route', pk: 'deliveryRouteId', displayName: '配送ルート' },
  '10': { name: 'system_users', pk: 'userId', displayName: 'システム利用者' }
};

interface APIGatewayEvent {
  httpMethod: string;
  path: string;
  pathParameters?: { [key: string]: string };
  queryStringParameters?: { [key: string]: string };
  body?: string;
  headers: { [key: string]: string };
}

interface APIGatewayResponse {
  statusCode: number;
  headers: { [key: string]: string };
  body: string;
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

async function writeAuditLog(user: User, action: string, resource: string, details: any = {}) {
  const auditLog = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    userId: user.id,
    userRole: user.role,
    action,
    resource,
    timestamp: new Date().toISOString(),
    details
  };
  
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditLog
  }));
}

function validateTableIndex(tableIndex: string): boolean {
  return tableIndex in TABLE_CONFIGS;
}

function addTimestamps(item: any, isUpdate: boolean = false): any {
  const now = new Date().toISOString();
  if (!isUpdate) {
    item.createdAt = now;
  }
  item.updatedAt = now;
  return item;
}

async function handleBulkImport(tableIndex: string, items: any[], user: User): Promise<any> {
  if (!hasPermission(user, 'bulk', 'bulk')) {
    return createResponse(403, { error: 'Insufficient permissions for bulk import' });
  }

  const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
  let imported = 0;
  let failed = 0;
  const errors: string[] = [];

  // Process in batches of 25 (DynamoDB BatchWrite limit)
  for (let i = 0; i < items.length; i += 25) {
    const batch = items.slice(i, i + 25);
    const writeRequests = batch.map(item => {
      const processedItem = {
        ...item,
        pk: config.name,
        sk: item[config.pk] || randomUUID(),
        [config.pk]: item[config.pk] || randomUUID()
      };
      addTimestamps(processedItem, false);
      
      return {
        PutRequest: {
          Item: processedItem
        }
      };
    });

    try {
      await docClient.send(new BatchWriteCommand({
        RequestItems: {
          [TABLE_NAME]: writeRequests
        }
      }));
      imported += batch.length;
    } catch (error) {
      failed += batch.length;
      errors.push(`Batch ${Math.floor(i/25) + 1}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  await writeAuditLog(user, 'BULK_IMPORT', config.displayName, { imported, failed, totalItems: items.length });

  return createResponse(200, { imported, failed, errors });
}

export const handler = async (event: APIGatewayEvent): Promise<APIGatewayResponse> => {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return createResponse(200, {});
    }

    let user: User;
    try {
      user = extractUserFromEvent(event);
    } catch (error) {
      return createResponse(401, { error: 'Unauthorized' });
    }

    const path = event.path;
    const method = event.httpMethod;
    const pathParts = path.split('/').filter(p => p);

    // Handle /resources endpoint
    if (path === '/resources' && method === 'GET') {
      if (!hasPermission(user, 'resources', 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const resources = Object.entries(TABLE_CONFIGS).map(([index, config]) => ({
        index,
        name: config.name,
        displayName: config.displayName,
        primaryKey: config.pk
      }));

      return createResponse(200, { resources });
    }

    // Handle table-specific endpoints: /api/{tableIndex}/*
    if (pathParts.length >= 2 && pathParts[0] === 'api') {
      const tableIndex = pathParts[1];
      
      if (!validateTableIndex(tableIndex)) {
        return createResponse(404, { error: 'Table not found' });
      }

      const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];

      // Bulk import endpoint: POST /api/{tableIndex}/bulk
      if (pathParts.length === 3 && pathParts[2] === 'bulk' && method === 'POST') {
        if (!event.body) {
          return createResponse(400, { error: 'Request body required' });
        }

        let requestBody;
        try {
          requestBody = JSON.parse(event.body);
        } catch (error) {
          return createResponse(400, { error: 'Invalid JSON in request body' });
        }

        if (!requestBody.items || !Array.isArray(requestBody.items)) {
          return createResponse(400, { error: 'Request body must contain items array' });
        }

        return await handleBulkImport(tableIndex, requestBody.items, user);
      }

      // List items: GET /api/{tableIndex}
      if (pathParts.length === 2 && method === 'GET') {
        if (!hasPermission(user, config.name, 'read')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        try {
          const result = await docClient.send(new ScanCommand({
            TableName: TABLE_NAME,
            FilterExpression: 'pk = :pk',
            ExpressionAttributeValues: {
              ':pk': config.name
            }
          }));

          return createResponse(200, { items: result.Items || [] });
        } catch (error) {
          return createResponse(500, { error: 'Internal server error' });
        }
      }

      // Get item by ID: GET /api/{tableIndex}/{id}
      if (pathParts.length === 3 && method === 'GET') {
        if (!hasPermission(user, config.name, 'read')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        const id = pathParts[2];
        try {
          const result = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: config.name,
              sk: id
            }
          }));

          if (!result.Item) {
            return createResponse(404, { error: 'Item not found' });
          }

          return createResponse(200, result.Item);
        } catch (error) {
          return createResponse(500, { error: 'Internal server error' });
        }
      }

      // Create item: POST /api/{tableIndex}
      if (pathParts.length === 2 && method === 'POST') {
        if (!hasPermission(user, config.name, 'create')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        if (!event.body) {
          return createResponse(400, { error: 'Request body required' });
        }

        let item;
        try {
          item = JSON.parse(event.body);
        } catch (error) {
          return createResponse(400, { error: 'Invalid JSON in request body' });
        }

        const id = item[config.pk] || randomUUID();
        const newItem = {
          ...item,
          pk: config.name,
          sk: id,
          [config.pk]: id,
          createdBy: user.id,
          updatedBy: user.id
        };
        addTimestamps(newItem, false);

        try {
          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: newItem
          }));

          await writeAuditLog(user, 'CREATE', config.displayName, { itemId: id });

          return createResponse(201, newItem);
        } catch (error) {
          return createResponse(500, { error: 'Internal server error' });
        }
      }

      // Update item: PUT /api/{tableIndex}/{id}
      if (pathParts.length === 3 && method === 'PUT') {
        if (!hasPermission(user, config.name, 'update')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        if (!event.body) {
          return createResponse(400, { error: 'Request body required' });
        }

        const id = pathParts[2];
        let updates;
        try {
          updates = JSON.parse(event.body);
        } catch (error) {
          return createResponse(400, { error: 'Invalid JSON in request body' });
        }

        const updatedItem = {
          ...updates,
          pk: config.name,
          sk: id,
          [config.pk]: id,
          updatedBy: user.id
        };
        addTimestamps(updatedItem, true);

        try {
          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: updatedItem
          }));

          await writeAuditLog(user, 'UPDATE', config.displayName, { itemId: id });

          return createResponse(200, updatedItem);
        } catch (error) {
          return createResponse(500, { error: 'Internal server error' });
        }
      }

      // Delete item: DELETE /api/{tableIndex}/{id}
      if (pathParts.length === 3 && method === 'DELETE') {
        if (!hasPermission(user, config.name, 'delete')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        const id = pathParts[2];
        try {
          await docClient.send(new DeleteCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: config.name,
              sk: id
            }
          }));

          await writeAuditLog(user, 'DELETE', config.displayName, { itemId: id });

          return createResponse(204, {});
        } catch (error) {
          return createResponse(500, { error: 'Internal server error' });
        }
      }
    }

    return createResponse(404, { error: 'Endpoint not found' });
  } catch (error) {
    console.error('Handler error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};