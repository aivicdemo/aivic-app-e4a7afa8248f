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
  '6': { name: 'seasonalVariationAnalysis', pk: 'seasonalVariationAnalysisId', entityType: 'SEASONAL_ANALYSIS' },
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

function getRequiredFieldsByTableIndex(tableIndex: string): string[] {
  const fieldMap: { [key: string]: string[] } = {
    '0': ['storeCode', 'storeName', 'storeCategory', 'prefecture', 'city', 'transactionStartDate', 'transactionStatus', 'validFlag', 'createdBy', 'updatedBy'],
    '1': ['storeId', 'customerName', 'productName', 'category', 'capacityMl', 'remainingMl', 'remainingPercent', 'keepStartDate', 'status', 'createdBy'],
    '2': ['memberId', 'storeId', 'visitDateTime', 'keepBottleUsedFlag', 'newBottleOrderFlag', 'createdBy'],
    '3': ['storeId', 'keepBottleId', 'memberId', 'consumptionDateTime', 'consumptionAmount', 'remainingAmount', 'completedFlag', 'createdBy'],
    '4': ['storeId', 'productCategory', 'forecastPeriodStart', 'forecastPeriodEnd', 'forecastDemand', 'confidenceLevel', 'seasonalFactorFlag', 'eventFactorFlag', 'recommendedPurchaseAmount', 'createdBy'],
    '5': ['storeId', 'aggregateYearMonth', 'productCategory', 'newKeepBottles', 'completedBottles', 'totalConsumption', 'visitCount', 'activeMemberCount', 'averageConsumption', 'createdBy'],
    '6': ['analysisYear', 'analysisMonth', 'alcoholCategory', 'regionCode', 'baseConsumption', 'actualConsumption', 'seasonalIndex', 'eventImpactFlag', 'createdBy'],
    '7': ['storeId', 'productCode', 'productName', 'planPeriodStart', 'planPeriodEnd', 'currentStock', 'forecastDemand', 'safetyStock', 'plannedReplenishment', 'scheduledDate', 'planStatus', 'priority', 'createdBy'],
    '8': ['storeId', 'productCode', 'productName', 'scheduledDeliveryDate', 'scheduledQuantity', 'deliveryStatus', 'createdBy'],
    '9': ['routeName', 'driverId', 'vehicleId', 'startLocation', 'endLocation', 'estimatedDuration', 'totalDistance', 'maxCapacity', 'deliveryDays', 'startTime', 'validFlag', 'createdBy'],
    '10': ['loginId', 'passwordHash', 'userName', 'email', 'permissionLevel', 'organization', 'accountStatus', 'createdBy']
  };
  return fieldMap[tableIndex] || [];
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
    
    if (path === '/resources' && method === 'GET') {
      if (!hasPermission(user, 'resources', 'read')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      const resources = Object.entries(TABLE_CONFIGS).map(([index, config]) => ({
        index,
        name: config.name,
        entityType: config.entityType
      }));

      return createResponse(200, { resources });
    }

    const pathMatch = path.match(/^\/api\/(\d+)(?:\/(\w+))?(?:\/(\w+))?$/);
    if (!pathMatch) {
      return createResponse(404, { error: 'Not found' });
    }

    const [, tableIndex, action, itemId] = pathMatch;
    const tableConfig = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    
    if (!tableConfig) {
      return createResponse(404, { error: 'Table not found' });
    }

    if (action === 'bulk' && method === 'POST') {
      if (!hasPermission(user, tableConfig.name, 'bulk')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      const body = JSON.parse(event.body || '{}');
      const items = body.items || [];
      
      if (!Array.isArray(items)) {
        return createResponse(400, { error: 'Items must be an array' });
      }

      const requiredFields = getRequiredFieldsByTableIndex(tableIndex);
      let imported = 0;
      let failed = 0;
      const errors: string[] = [];
      const now = new Date().toISOString();

      const batches = [];
      for (let i = 0; i < items.length; i += 25) {
        batches.push(items.slice(i, i + 25));
      }

      for (const batch of batches) {
        const writeRequests = [];
        
        for (const item of batch) {
          const validationErrors = validateRequiredFields(item, requiredFields);
          if (validationErrors.length > 0) {
            failed++;
            errors.push(`Item validation failed: ${validationErrors.join(', ')}`);
            continue;
          }

          const enrichedItem = {
            ...item,
            [tableConfig.pk]: item[tableConfig.pk] || randomUUID(),
            pk: tableConfig.entityType,
            sk: item[tableConfig.pk] || randomUUID(),
            createdAt: now,
            updatedAt: now
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

      await createAuditLog(user, 'BULK_IMPORT', tableConfig.name, {
        tableIndex,
        imported,
        failed,
        totalItems: items.length
      });

      return createResponse(200, { imported, failed, errors });
    }

    switch (method) {
      case 'GET':
        if (!hasPermission(user, tableConfig.name, 'read')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        if (itemId) {
          const result = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: tableConfig.entityType,
              sk: itemId
            }
          }));

          if (!result.Item) {
            return createResponse(404, { error: 'Item not found' });
          }

          return createResponse(200, result.Item);
        } else {
          const limit = event.queryStringParameters?.limit ? parseInt(event.queryStringParameters.limit) : 50;
          const result = await docClient.send(new ScanCommand({
            TableName: TABLE_NAME,
            FilterExpression: 'pk = :pk',
            ExpressionAttributeValues: {
              ':pk': tableConfig.entityType
            },
            Limit: Math.min(limit, 100)
          }));

          return createResponse(200, {
            items: result.Items || [],
            count: result.Count || 0
          });
        }

      case 'POST':
        if (!hasPermission(user, tableConfig.name, 'create')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        const createBody = JSON.parse(event.body || '{}');
        const requiredFields = getRequiredFieldsByTableIndex(tableIndex);
        const validationErrors = validateRequiredFields(createBody, requiredFields);
        
        if (validationErrors.length > 0) {
          return createResponse(400, { error: 'Validation failed', details: validationErrors });
        }

        const newId = randomUUID();
        const now = new Date().toISOString();
        const newItem = {
          ...createBody,
          [tableConfig.pk]: newId,
          pk: tableConfig.entityType,
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

        await createAuditLog(user, 'CREATE', tableConfig.name, { itemId: newId });

        return createResponse(201, newItem);

      case 'PUT':
        if (!itemId) {
          return createResponse(400, { error: 'Item ID required for update' });
        }

        if (!hasPermission(user, tableConfig.name, 'update')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        const updateBody = JSON.parse(event.body || '{}');
        const existingItem = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: tableConfig.entityType,
            sk: itemId
          }
        }));

        if (!existingItem.Item) {
          return createResponse(404, { error: 'Item not found' });
        }

        const updatedItem = {
          ...existingItem.Item,
          ...updateBody,
          updatedAt: new Date().toISOString(),
          updatedBy: user.id
        };

        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: updatedItem
        }));

        await createAuditLog(user, 'UPDATE', tableConfig.name, { itemId });

        return createResponse(200, updatedItem);

      case 'DELETE':
        if (!itemId) {
          return createResponse(400, { error: 'Item ID required for delete' });
        }

        if (!hasPermission(user, tableConfig.name, 'delete')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        const itemToDelete = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: tableConfig.entityType,
            sk: itemId
          }
        }));

        if (!itemToDelete.Item) {
          return createResponse(404, { error: 'Item not found' });
        }

        await docClient.send(new DeleteCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: tableConfig.entityType,
            sk: itemId
          }
        }));

        await createAuditLog(user, 'DELETE', tableConfig.name, { itemId });

        return createResponse(200, { message: 'Item deleted successfully' });

      default:
        return createResponse(405, { error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};