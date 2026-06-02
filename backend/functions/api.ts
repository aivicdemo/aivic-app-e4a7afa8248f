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

async function createAuditLog(user: User, action: string, resource: string, details: any) {
  const auditLog = {
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

function getRequiredFields(entityType: string): string[] {
  const fieldMap: Record<string, string[]> = {
    'STORE': ['storeCode', 'storeName', 'storeCategory', 'prefecture', 'city', 'transactionStartDate', 'transactionStatus', 'activeFlag'],
    'KEEP_BOTTLE': ['storeId', 'customerName', 'productName', 'category', 'capacityMl', 'remainingMl', 'remainingPercent', 'keepStartDate', 'status'],
    'MEMBER_VISIT': ['memberId', 'storeId', 'visitDateTime', 'keepBottleUsedFlag', 'newBottleOrderFlag'],
    'BOTTLE_CONSUMPTION': ['storeId', 'keepBottleId', 'memberId', 'consumptionDateTime', 'consumptionAmount', 'remainingAmount', 'completedFlag'],
    'DEMAND_FORECAST': ['storeId', 'productCategory', 'forecastPeriodStart', 'forecastPeriodEnd', 'forecastDemand', 'confidenceLevel', 'seasonalFlag', 'eventFlag', 'recommendedPurchase'],
    'MONTHLY_AGGREGATE': ['storeId', 'aggregateMonth', 'productCategory', 'newKeepBottles', 'completedBottles', 'totalConsumption', 'visitCount', 'activeMemberCount', 'averageConsumption'],
    'SEASONAL_ANALYSIS': ['analysisYear', 'analysisMonth', 'alcoholCategory', 'regionCode', 'baseConsumption', 'actualConsumption', 'seasonalIndex', 'eventImpactFlag', 'temperatureImpact'],
    'REPLENISHMENT_PLAN': ['storeId', 'productCode', 'productName', 'planPeriodStart', 'planPeriodEnd', 'currentStock', 'forecastDemand', 'safetyStock', 'plannedReplenishment', 'scheduledDate', 'planStatus', 'priority'],
    'DELIVERY_SCHEDULE': ['storeId', 'productCode', 'productName', 'scheduledDeliveryDate', 'scheduledQuantity', 'deliveryStatus'],
    'DELIVERY_ROUTE': ['routeName', 'driverUserId', 'vehicleId', 'startLocation', 'endLocation', 'estimatedDuration', 'totalDistance', 'maxCapacity', 'deliveryDays', 'startTime', 'activeFlag'],
    'SYSTEM_USER': ['loginId', 'passwordHash', 'userName', 'email', 'permissionLevel', 'organization', 'accountStatus']
  };
  return fieldMap[entityType] || [];
}

export const handler = async (event: any): Promise<APIResponse> => {
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

    const path = event.path || event.rawPath || '';
    const method = event.httpMethod || event.requestContext?.http?.method || '';
    
    if (path === '/resources' && method === 'GET') {
      if (!hasPermission(user, 'resources', 'read')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      const resources = Object.entries(TABLE_CONFIGS).map(([index, config]) => ({
        index,
        name: config.name,
        entityType: config.entityType,
        endpoints: {
          list: `GET /api/${index}`,
          get: `GET /api/${index}/{id}`,
          create: `POST /api/${index}`,
          update: `PUT /api/${index}/{id}`,
          delete: `DELETE /api/${index}/{id}`,
          bulk: `POST /api/${index}/bulk`
        }
      }));

      return createResponse(200, { resources });
    }

    const apiMatch = path.match(/^\/api\/(\d+)(?:\/(\w+))?(?:\/(\w+))?$/);
    if (!apiMatch) {
      return createResponse(404, { error: 'Not found' });
    }

    const [, tableIndex, resourceId, action] = apiMatch;
    const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    
    if (!config) {
      return createResponse(404, { error: 'Table not found' });
    }

    if (action === 'bulk' && method === 'POST') {
      if (!hasPermission(user, config.name, 'bulk')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      const body = JSON.parse(event.body || '{}');
      const items = body.items || [];
      
      if (!Array.isArray(items)) {
        return createResponse(400, { error: 'Items must be an array' });
      }

      const requiredFields = getRequiredFields(config.entityType);
      let imported = 0;
      let failed = 0;
      const errors: string[] = [];

      const chunks = [];
      for (let i = 0; i < items.length; i += 25) {
        chunks.push(items.slice(i, i + 25));
      }

      for (const chunk of chunks) {
        const writeRequests = [];
        
        for (const item of chunk) {
          const validationErrors = validateRequired(item, requiredFields);
          if (validationErrors.length > 0) {
            failed++;
            errors.push(`Item validation failed: ${validationErrors.join(', ')}`);
            continue;
          }

          const now = new Date().toISOString();
          const processedItem = {
            ...item,
            [config.pk]: item[config.pk] || randomUUID(),
            pk: config.entityType,
            sk: item[config.pk] || randomUUID(),
            createdAt: now,
            updatedAt: now,
            createdBy: user.id,
            updatedBy: user.id
          };

          writeRequests.push({
            PutRequest: {
              Item: processedItem
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

      await createAuditLog(user, 'BULK_IMPORT', config.name, { imported, failed, totalItems: items.length });

      return createResponse(200, { imported, failed, errors });
    }

    switch (method) {
      case 'GET':
        if (!hasPermission(user, config.name, 'read')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        if (resourceId) {
          const result = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: config.entityType,
              sk: resourceId
            }
          }));

          if (!result.Item) {
            return createResponse(404, { error: 'Item not found' });
          }

          return createResponse(200, { item: result.Item });
        } else {
          const result = await docClient.send(new ScanCommand({
            TableName: TABLE_NAME,
            FilterExpression: 'pk = :pk',
            ExpressionAttributeValues: {
              ':pk': config.entityType
            }
          }));

          return createResponse(200, { items: result.Items || [] });
        }

      case 'POST':
        if (!hasPermission(user, config.name, 'create')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        const createBody = JSON.parse(event.body || '{}');
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

        await createAuditLog(user, 'CREATE', config.name, { id: newId });

        return createResponse(201, { item: newItem });

      case 'PUT':
        if (!hasPermission(user, config.name, 'update')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        if (!resourceId) {
          return createResponse(400, { error: 'Resource ID required' });
        }

        const updateBody = JSON.parse(event.body || '{}');
        const updateNow = new Date().toISOString();
        
        const existingItem = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: config.entityType,
            sk: resourceId
          }
        }));

        if (!existingItem.Item) {
          return createResponse(404, { error: 'Item not found' });
        }

        const updatedItem = {
          ...existingItem.Item,
          ...updateBody,
          updatedAt: updateNow,
          updatedBy: user.id
        };

        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: updatedItem
        }));

        await createAuditLog(user, 'UPDATE', config.name, { id: resourceId });

        return createResponse(200, { item: updatedItem });

      case 'DELETE':
        if (!hasPermission(user, config.name, 'delete')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        if (!resourceId) {
          return createResponse(400, { error: 'Resource ID required' });
        }

        const deleteItem = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: config.entityType,
            sk: resourceId
          }
        }));

        if (!deleteItem.Item) {
          return createResponse(404, { error: 'Item not found' });
        }

        await docClient.send(new DeleteCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: config.entityType,
            sk: resourceId
          }
        }));

        await createAuditLog(user, 'DELETE', config.name, { id: resourceId });

        return createResponse(200, { message: 'Item deleted successfully' });

      default:
        return createResponse(405, { error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};