import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { hasPermission, extractUserFromEvent, User } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

const TABLE_CONFIGS = {
  '0': { name: 'stores', pk: 'storeId', entityType: 'STORE' },
  '1': { name: 'keep_bottles', pk: 'keepBottleId', entityType: 'KEEP_BOTTLE' },
  '2': { name: 'member_visits', pk: 'visitHistoryId', entityType: 'MEMBER_VISIT' },
  '3': { name: 'bottle_consumption', pk: 'consumptionHistoryId', entityType: 'BOTTLE_CONSUMPTION' },
  '4': { name: 'demand_forecasts', pk: 'forecastReportId', entityType: 'DEMAND_FORECAST' },
  '5': { name: 'monthly_aggregates', pk: 'aggregateId', entityType: 'MONTHLY_AGGREGATE' },
  '6': { name: 'seasonal_analysis', pk: 'seasonalAnalysisId', entityType: 'SEASONAL_ANALYSIS' },
  '7': { name: 'replenishment_plans', pk: 'replenishmentPlanId', entityType: 'REPLENISHMENT_PLAN' },
  '8': { name: 'delivery_schedules', pk: 'deliveryScheduleId', entityType: 'DELIVERY_SCHEDULE' },
  '9': { name: 'delivery_routes', pk: 'deliveryRouteId', entityType: 'DELIVERY_ROUTE' },
  '10': { name: 'system_users', pk: 'userId', entityType: 'SYSTEM_USER' }
};

interface APIResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

function createResponse(statusCode: number, body: any): APIResponse {
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

async function createAuditLog(user: User, action: string, resource: string, details: any = {}) {
  const auditRecord = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    userId: user.id,
    userRole: user.role,
    action,
    resource,
    details,
    timestamp: new Date().toISOString()
  };
  
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditRecord
  }));
}

function validateRequired(data: any, requiredFields: string[]): string[] {
  const errors: string[] = [];
  for (const field of requiredFields) {
    if (data[field] === undefined || data[field] === null || data[field] === '') {
      errors.push(`${field} is required`);
    }
  }
  return errors;
}

function getRequiredFields(entityType: string): string[] {
  const fieldMap: Record<string, string[]> = {
    'STORE': ['storeCode', 'storeName', 'storeCategory', 'prefecture', 'city', 'transactionStartDate', 'transactionStatus', 'isActive', 'createdBy', 'updatedBy'],
    'KEEP_BOTTLE': ['storeId', 'customerName', 'productName', 'category', 'capacityMl', 'remainingMl', 'remainingPercent', 'keepStartDate', 'status', 'createdBy'],
    'MEMBER_VISIT': ['memberId', 'storeId', 'visitDateTime', 'keepBottleUsed', 'newBottleOrdered', 'createdBy'],
    'BOTTLE_CONSUMPTION': ['storeId', 'keepBottleId', 'memberId', 'consumptionDateTime', 'consumptionAmount', 'remainingAmount', 'isFinished', 'createdBy'],
    'DEMAND_FORECAST': ['storeId', 'productCategory', 'forecastPeriodStart', 'forecastPeriodEnd', 'forecastDemand', 'confidenceLevel', 'seasonalFactor', 'eventFactor', 'recommendedPurchase', 'createdBy'],
    'MONTHLY_AGGREGATE': ['storeId', 'aggregateMonth', 'productCategory', 'newKeepBottles', 'completedBottles', 'totalConsumption', 'totalVisitors', 'activeMembers', 'averageConsumption', 'createdBy'],
    'SEASONAL_ANALYSIS': ['analysisYear', 'analysisMonth', 'alcoholCategory', 'regionCode', 'baseConsumption', 'actualConsumption', 'seasonalIndex', 'eventImpact', 'temperatureImpact', 'createdBy'],
    'REPLENISHMENT_PLAN': ['storeId', 'productCode', 'productName', 'planPeriodStart', 'planPeriodEnd', 'currentStock', 'forecastDemand', 'safetyStock', 'plannedReplenishment', 'scheduledDate', 'planStatus', 'priority', 'createdBy'],
    'DELIVERY_SCHEDULE': ['storeId', 'productCode', 'productName', 'scheduledDeliveryDate', 'scheduledQuantity', 'deliveryStatus', 'createdBy'],
    'DELIVERY_ROUTE': ['routeName', 'driverId', 'vehicleId', 'startLocation', 'endLocation', 'estimatedDuration', 'totalDistance', 'maxCapacity', 'deliveryDays', 'startTime', 'isActive', 'createdBy'],
    'SYSTEM_USER': ['loginId', 'passwordHash', 'userName', 'email', 'permissionLevel', 'organization', 'accountStatus', 'createdBy']
  };
  return fieldMap[entityType] || [];
}

async function handleBulkImport(event: any, user: User, tableIndex: string) {
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

  if (!requestBody.items || !Array.isArray(requestBody.items)) {
    return createResponse(400, { error: 'Request body must contain items array' });
  }

  const items = requestBody.items;
  let imported = 0;
  let failed = 0;
  const errors: string[] = [];
  const requiredFields = getRequiredFields(config.entityType);

  // Process in batches of 25 (DynamoDB BatchWrite limit)
  for (let i = 0; i < items.length; i += 25) {
    const batch = items.slice(i, i + 25);
    const writeRequests = [];

    for (const item of batch) {
      const validationErrors = validateRequired(item, requiredFields);
      if (validationErrors.length > 0) {
        failed++;
        errors.push(`Item ${i + batch.indexOf(item)}: ${validationErrors.join(', ')}`);
        continue;
      }

      const now = new Date().toISOString();
      const enrichedItem = {
        ...item,
        [config.pk]: item[config.pk] || randomUUID(),
        pk: config.entityType,
        sk: item[config.pk] || randomUUID(),
        createdAt: now,
        updatedAt: now,
        createdBy: item.createdBy || user.id,
        updatedBy: user.id
      };

      writeRequests.push({
        PutRequest: {
          Item: enrichedItem
        }
      });
    }

    if (writeRequests.length > 0) {
      try {
        await docClient.send(new BatchWriteCommand({
          RequestItems: {
            [TABLE_NAME]: writeRequests
          }
        }));
        imported += writeRequests.length;
      } catch (error) {
        failed += writeRequests.length;
        errors.push(`Batch write failed: ${error}`);
      }
    }
  }

  await createAuditLog(user, 'BULK_IMPORT', config.entityType, {
    tableIndex,
    totalItems: items.length,
    imported,
    failed
  });

  return createResponse(200, {
    imported,
    failed,
    errors
  });
}

export const handler = async (event: any): Promise<APIResponse> => {
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

    const path = event.path || event.rawPath || '';
    const method = event.httpMethod || event.requestContext?.http?.method || 'GET';
    const pathParams = event.pathParameters || {};

    // Handle /resources endpoint
    if (path === '/resources' && method === 'GET') {
      if (!hasPermission(user, 'resources', 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const resources = Object.entries(TABLE_CONFIGS).map(([index, config]) => ({
        index,
        name: config.name,
        entityType: config.entityType,
        primaryKey: config.pk
      }));

      return createResponse(200, { resources });
    }

    // Handle bulk import endpoints
    const bulkMatch = path.match(/^\/api\/(\d+)\/bulk$/);
    if (bulkMatch && method === 'POST') {
      return await handleBulkImport(event, user, bulkMatch[1]);
    }

    // Handle table-specific CRUD operations
    const tableMatch = path.match(/^\/api\/(\d+)(?:\/(\w+))?$/);
    if (tableMatch) {
      const tableIndex = tableMatch[1];
      const itemId = tableMatch[2];
      const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
      
      if (!config) {
        return createResponse(404, { error: 'Table not found' });
      }

      switch (method) {
        case 'GET':
          if (!hasPermission(user, config.name, 'read')) {
            return createResponse(403, { error: 'Insufficient permissions' });
          }

          if (itemId) {
            // Get single item
            const result = await docClient.send(new GetCommand({
              TableName: TABLE_NAME,
              Key: {
                pk: config.entityType,
                sk: itemId
              }
            }));

            if (!result.Item) {
              return createResponse(404, { error: 'Item not found' });
            }

            return createResponse(200, result.Item);
          } else {
            // List items
            const result = await docClient.send(new ScanCommand({
              TableName: TABLE_NAME,
              FilterExpression: 'pk = :pk',
              ExpressionAttributeValues: {
                ':pk': config.entityType
              }
            }));

            return createResponse(200, {
              items: result.Items || [],
              count: result.Count || 0
            });
          }

        case 'POST':
          if (!hasPermission(user, config.name, 'create')) {
            return createResponse(403, { error: 'Insufficient permissions' });
          }

          let createBody;
          try {
            createBody = JSON.parse(event.body || '{}');
          } catch (error) {
            return createResponse(400, { error: 'Invalid JSON' });
          }

          const requiredFields = getRequiredFields(config.entityType);
          const validationErrors = validateRequired(createBody, requiredFields);
          if (validationErrors.length > 0) {
            return createResponse(400, { error: 'Validation failed', details: validationErrors });
          }

          const newId = randomUUID();
          const now = new Date().toISOString();
          const newItem = {
            ...createBody,
            [config.pk]: newId,
            pk: config.entityType,
            sk: newId,
            createdAt: now,
            updatedAt: now,
            createdBy: user.id,
            updatedBy: user.id
          };

          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: newItem
          }));

          await createAuditLog(user, 'CREATE', config.entityType, { itemId: newId });

          return createResponse(201, newItem);

        case 'PUT':
          if (!itemId) {
            return createResponse(400, { error: 'Item ID required for update' });
          }

          if (!hasPermission(user, config.name, 'update')) {
            return createResponse(403, { error: 'Insufficient permissions' });
          }

          let updateBody;
          try {
            updateBody = JSON.parse(event.body || '{}');
          } catch (error) {
            return createResponse(400, { error: 'Invalid JSON' });
          }

          // Check if item exists
          const existingItem = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: config.entityType,
              sk: itemId
            }
          }));

          if (!existingItem.Item) {
            return createResponse(404, { error: 'Item not found' });
          }

          const updatedItem = {
            ...existingItem.Item,
            ...updateBody,
            [config.pk]: itemId,
            pk: config.entityType,
            sk: itemId,
            updatedAt: new Date().toISOString(),
            updatedBy: user.id
          };

          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: updatedItem
          }));

          await createAuditLog(user, 'UPDATE', config.entityType, { itemId });

          return createResponse(200, updatedItem);

        case 'DELETE':
          if (!itemId) {
            return createResponse(400, { error: 'Item ID required for deletion' });
          }

          if (!hasPermission(user, config.name, 'delete')) {
            return createResponse(403, { error: 'Insufficient permissions' });
          }

          // Check if item exists
          const itemToDelete = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: config.entityType,
              sk: itemId
            }
          }));

          if (!itemToDelete.Item) {
            return createResponse(404, { error: 'Item not found' });
          }

          await docClient.send(new DeleteCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: config.entityType,
              sk: itemId
            }
          }));

          await createAuditLog(user, 'DELETE', config.entityType, { itemId });

          return createResponse(200, { message: 'Item deleted successfully' });

        default:
          return createResponse(405, { error: 'Method not allowed' });
      }
    }

    return createResponse(404, { error: 'Endpoint not found' });

  } catch (error) {
    console.error('Handler error:', error);
    return createResponse(500, {
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};