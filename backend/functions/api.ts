import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { hasPermission, extractUserFromEvent, User } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

const TABLE_CONFIGS = {
  '0': { name: 'stores', pk: 'storeId', entityType: 'STORE' },
  '1': { name: 'keepBottleInventory', pk: 'keepBottleId', entityType: 'KEEP_BOTTLE' },
  '2': { name: 'memberVisitHistory', pk: 'visitHistoryId', entityType: 'VISIT_HISTORY' },
  '3': { name: 'keepBottleConsumptionHistory', pk: 'consumptionHistoryId', entityType: 'CONSUMPTION_HISTORY' },
  '4': { name: 'demandForecastReport', pk: 'forecastReportId', entityType: 'FORECAST_REPORT' },
  '5': { name: 'monthlyAggregateData', pk: 'aggregateId', entityType: 'MONTHLY_AGGREGATE' },
  '6': { name: 'seasonalVariationAnalysis', pk: 'seasonalVariationId', entityType: 'SEASONAL_VARIATION' },
  '7': { name: 'replenishmentPlan', pk: 'replenishmentPlanId', entityType: 'REPLENISHMENT_PLAN' },
  '8': { name: 'deliverySchedule', pk: 'deliveryScheduleId', entityType: 'DELIVERY_SCHEDULE' },
  '9': { name: 'deliveryRoute', pk: 'deliveryRouteId', entityType: 'DELIVERY_ROUTE' },
  '10': { name: 'systemUsers', pk: 'userId', entityType: 'SYSTEM_USER' }
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

function validateRequiredFields(item: any, requiredFields: string[]): string[] {
  const errors: string[] = [];
  for (const field of requiredFields) {
    if (item[field] === undefined || item[field] === null || item[field] === '') {
      errors.push(`${field} is required`);
    }
  }
  return errors;
}

function getRequiredFieldsByEntityType(entityType: string): string[] {
  const fieldMap: { [key: string]: string[] } = {
    'STORE': ['storeCode', 'storeName', 'storeCategory', 'prefecture', 'city', 'transactionStartDate', 'transactionStatus', 'validFlag', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy'],
    'KEEP_BOTTLE': ['storeId', 'customerName', 'productName', 'category', 'capacityMl', 'remainingMl', 'remainingPercent', 'keepStartDate', 'status', 'createdAt', 'updatedAt', 'createdBy'],
    'VISIT_HISTORY': ['memberId', 'storeId', 'visitDateTime', 'keepBottleUsedFlag', 'newBottleOrderFlag', 'createdAt', 'updatedAt', 'createdBy'],
    'CONSUMPTION_HISTORY': ['storeId', 'keepBottleId', 'memberId', 'consumptionDateTime', 'consumptionAmount', 'remainingAmount', 'completedFlag', 'createdAt', 'createdBy'],
    'FORECAST_REPORT': ['storeId', 'productCategory', 'forecastPeriodStart', 'forecastPeriodEnd', 'predictedDemand', 'confidenceLevel', 'seasonalFactorFlag', 'eventFactorFlag', 'recommendedPurchaseAmount', 'createdAt', 'updatedAt', 'createdBy'],
    'MONTHLY_AGGREGATE': ['storeId', 'aggregateYearMonth', 'productCategory', 'newKeepBottles', 'completedBottles', 'totalConsumption', 'totalVisitors', 'activeMembers', 'averageConsumption', 'createdAt', 'updatedAt', 'createdBy'],
    'SEASONAL_VARIATION': ['analysisYear', 'analysisMonth', 'alcoholCategory', 'regionCode', 'baseConsumption', 'actualConsumption', 'seasonalIndex', 'eventInfluenceFlag', 'temperatureInfluence', 'createdAt', 'updatedAt', 'createdBy'],
    'REPLENISHMENT_PLAN': ['storeId', 'productCode', 'productName', 'planPeriodStart', 'planPeriodEnd', 'currentStock', 'predictedDemand', 'safetyStock', 'plannedReplenishment', 'scheduledDate', 'planStatus', 'priority', 'createdAt', 'updatedAt', 'createdBy'],
    'DELIVERY_SCHEDULE': ['storeId', 'productCode', 'productName', 'scheduledDeliveryDate', 'scheduledQuantity', 'deliveryStatus', 'createdAt', 'updatedAt', 'createdBy'],
    'DELIVERY_ROUTE': ['routeName', 'driverId', 'vehicleId', 'startLocation', 'endLocation', 'estimatedDuration', 'totalDistance', 'maxCapacity', 'deliveryDays', 'startTime', 'validFlag', 'createdAt', 'updatedAt', 'createdBy'],
    'SYSTEM_USER': ['loginId', 'passwordHash', 'userName', 'email', 'permissionLevel', 'organization', 'accountStatus', 'createdAt', 'updatedAt', 'createdBy']
  };
  return fieldMap[entityType] || [];
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

    if (pathParts[0] === 'resources') {
      if (method === 'GET') {
        if (!hasPermission(user, 'resources', 'read')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        const limit = event.queryStringParameters?.limit ? parseInt(event.queryStringParameters.limit) : 50;
        const entityType = event.queryStringParameters?.entityType;
        
        let scanParams: any = {
          TableName: TABLE_NAME,
          Limit: Math.min(limit, 100)
        };

        if (entityType) {
          scanParams.FilterExpression = 'entityType = :entityType';
          scanParams.ExpressionAttributeValues = { ':entityType': entityType };
        }

        if (event.queryStringParameters?.lastEvaluatedKey) {
          scanParams.ExclusiveStartKey = JSON.parse(decodeURIComponent(event.queryStringParameters.lastEvaluatedKey));
        }

        const result = await docClient.send(new ScanCommand(scanParams));
        
        return createResponse(200, {
          items: result.Items || [],
          count: result.Count || 0,
          lastEvaluatedKey: result.LastEvaluatedKey ? encodeURIComponent(JSON.stringify(result.LastEvaluatedKey)) : null
        });
      }
    }

    if (pathParts[0] === 'api' && pathParts[1] && TABLE_CONFIGS[pathParts[1] as keyof typeof TABLE_CONFIGS]) {
      const tableIndex = pathParts[1];
      const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
      const resourceId = pathParts[2];

      if (pathParts[2] === 'bulk' && method === 'POST') {
        if (!hasPermission(user, config.name, 'bulk')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        const body = JSON.parse(event.body || '{}');
        const items = body.items || [];
        
        if (!Array.isArray(items)) {
          return createResponse(400, { error: 'Items must be an array' });
        }

        let imported = 0;
        let failed = 0;
        const errors: string[] = [];
        const now = new Date().toISOString();
        const requiredFields = getRequiredFieldsByEntityType(config.entityType);

        const chunks = [];
        for (let i = 0; i < items.length; i += 25) {
          chunks.push(items.slice(i, i + 25));
        }

        for (const chunk of chunks) {
          const writeRequests = [];
          
          for (const item of chunk) {
            const validationErrors = validateRequiredFields(item, requiredFields.filter(f => !['createdAt', 'updatedAt'].includes(f)));
            if (validationErrors.length > 0) {
              failed++;
              errors.push(`Item validation failed: ${validationErrors.join(', ')}`);
              continue;
            }

            const enrichedItem = {
              ...item,
              [config.pk]: item[config.pk] || randomUUID(),
              entityType: config.entityType,
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

        await createAuditLog(user, 'BULK_IMPORT', config.name, { imported, failed, totalItems: items.length });

        return createResponse(200, { imported, failed, errors });
      }

      if (method === 'GET' && !resourceId) {
        if (!hasPermission(user, config.name, 'read')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        const limit = event.queryStringParameters?.limit ? parseInt(event.queryStringParameters.limit) : 50;
        
        let scanParams: any = {
          TableName: TABLE_NAME,
          FilterExpression: 'entityType = :entityType',
          ExpressionAttributeValues: { ':entityType': config.entityType },
          Limit: Math.min(limit, 100)
        };

        if (event.queryStringParameters?.lastEvaluatedKey) {
          scanParams.ExclusiveStartKey = JSON.parse(decodeURIComponent(event.queryStringParameters.lastEvaluatedKey));
        }

        const result = await docClient.send(new ScanCommand(scanParams));
        
        return createResponse(200, {
          items: result.Items || [],
          count: result.Count || 0,
          lastEvaluatedKey: result.LastEvaluatedKey ? encodeURIComponent(JSON.stringify(result.LastEvaluatedKey)) : null
        });
      }

      if (method === 'GET' && resourceId) {
        if (!hasPermission(user, config.name, 'read')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        const result = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: { [config.pk]: resourceId }
        }));

        if (!result.Item) {
          return createResponse(404, { error: 'Resource not found' });
        }

        return createResponse(200, result.Item);
      }

      if (method === 'POST' && !resourceId) {
        if (!hasPermission(user, config.name, 'create')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        const body = JSON.parse(event.body || '{}');
        const requiredFields = getRequiredFieldsByEntityType(config.entityType);
        const validationErrors = validateRequiredFields(body, requiredFields.filter(f => !['createdAt', 'updatedAt', 'createdBy', 'updatedBy'].includes(f)));
        
        if (validationErrors.length > 0) {
          return createResponse(400, { error: 'Validation failed', details: validationErrors });
        }

        const now = new Date().toISOString();
        const item = {
          ...body,
          [config.pk]: body[config.pk] || randomUUID(),
          entityType: config.entityType,
          createdAt: now,
          updatedAt: now,
          createdBy: user.id,
          updatedBy: user.id
        };

        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: item
        }));

        await createAuditLog(user, 'CREATE', config.name, { id: item[config.pk] });

        return createResponse(201, item);
      }

      if (method === 'PUT' && resourceId) {
        if (!hasPermission(user, config.name, 'update')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        const body = JSON.parse(event.body || '{}');
        
        const existingItem = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: { [config.pk]: resourceId }
        }));

        if (!existingItem.Item) {
          return createResponse(404, { error: 'Resource not found' });
        }

        const now = new Date().toISOString();
        const updatedItem = {
          ...existingItem.Item,
          ...body,
          [config.pk]: resourceId,
          entityType: config.entityType,
          updatedAt: now,
          updatedBy: user.id
        };

        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: updatedItem
        }));

        await createAuditLog(user, 'UPDATE', config.name, { id: resourceId });

        return createResponse(200, updatedItem);
      }

      if (method === 'DELETE' && resourceId) {
        if (!hasPermission(user, config.name, 'delete')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        const existingItem = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: { [config.pk]: resourceId }
        }));

        if (!existingItem.Item) {
          return createResponse(404, { error: 'Resource not found' });
        }

        await docClient.send(new DeleteCommand({
          TableName: TABLE_NAME,
          Key: { [config.pk]: resourceId }
        }));

        await createAuditLog(user, 'DELETE', config.name, { id: resourceId });

        return createResponse(200, { message: 'Resource deleted successfully' });
      }
    }

    return createResponse(404, { error: 'Endpoint not found' });

  } catch (error) {
    console.error('Error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};