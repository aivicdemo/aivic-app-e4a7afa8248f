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
  '10': { name: 'systemUser', pk: 'userId', entityType: 'SYSTEM_USER' }
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
    if (!item[field]) {
      errors.push(`${field} is required`);
    }
  }
  return errors;
}

function getRequiredFieldsByTableIndex(tableIndex: string): string[] {
  const fieldMap: { [key: string]: string[] } = {
    '0': ['storeCode', 'storeName', 'storeCategory', 'prefecture', 'city', 'transactionStartDate', 'transactionStatus', 'activeFlag', 'creatorId', 'updaterId'],
    '1': ['storeId', 'customerName', 'productName', 'category', 'capacityMl', 'remainingMl', 'remainingPercent', 'keepStartDate', 'status', 'creator'],
    '2': ['memberId', 'storeId', 'visitDateTime', 'keepBottleUsedFlag', 'newBottleOrderFlag', 'creator'],
    '3': ['storeId', 'keepBottleId', 'memberId', 'consumptionDateTime', 'consumptionAmount', 'remainingAmount', 'completedFlag', 'creator'],
    '4': ['storeId', 'productCategory', 'forecastPeriodStart', 'forecastPeriodEnd', 'forecastDemand', 'confidenceLevel', 'seasonalFactorFlag', 'eventFactorFlag', 'recommendedPurchaseAmount', 'creator'],
    '5': ['storeId', 'aggregateYearMonth', 'productCategory', 'newKeepBottles', 'completedBottles', 'totalConsumption', 'visitCount', 'activeMemberCount', 'averageConsumption', 'creator'],
    '6': ['analysisYear', 'analysisMonth', 'alcoholCategory', 'regionCode', 'baseConsumption', 'actualConsumption', 'seasonalVariationIndex', 'eventInfluenceFlag', 'creator'],
    '7': ['storeId', 'productCode', 'productName', 'planPeriodStart', 'planPeriodEnd', 'currentStock', 'forecastDemand', 'safetyStock', 'plannedReplenishment', 'scheduledReplenishmentDate', 'planStatus', 'priority', 'creator'],
    '8': ['storeId', 'productCode', 'productName', 'scheduledDeliveryDate', 'scheduledQuantity', 'deliveryStatus', 'creator'],
    '9': ['routeName', 'driverIdAssigned', 'vehicleIdAssigned', 'startLocation', 'endLocation', 'estimatedDuration', 'totalDistance', 'maxCapacity', 'deliveryDays', 'startTime', 'activeFlag', 'creator'],
    '10': ['loginId', 'passwordHash', 'userName', 'email', 'permissionLevel', 'organization', 'accountStatus', 'creator']
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

    const bulkMatch = path.match(/^\/api\/(\d+)\/bulk$/);
    if (bulkMatch && method === 'POST') {
      const tableIndex = bulkMatch[1];
      const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
      
      if (!config) {
        return createResponse(404, { error: 'Table not found' });
      }

      if (!hasPermission(user, config.name, 'bulk')) {
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

      for (let i = 0; i < items.length; i += 25) {
        const batch = items.slice(i, i + 25);
        const writeRequests = [];

        for (const item of batch) {
          const validationErrors = validateRequiredFields(item, requiredFields);
          if (validationErrors.length > 0) {
            failed++;
            errors.push(`Item ${i + batch.indexOf(item)}: ${validationErrors.join(', ')}`);
            continue;
          }

          const enrichedItem = {
            ...item,
            [config.pk]: item[config.pk] || randomUUID(),
            pk: config.entityType,
            sk: item[config.pk] || randomUUID(),
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

      await createAuditLog(user, 'BULK_IMPORT', config.name, {
        tableIndex,
        totalItems: items.length,
        imported,
        failed
      });

      return createResponse(200, { imported, failed, errors });
    }

    const apiMatch = path.match(/^\/api\/(\d+)(?:\/(\w+))?$/);
    if (apiMatch) {
      const tableIndex = apiMatch[1];
      const itemId = apiMatch[2];
      const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
      
      if (!config) {
        return createResponse(404, { error: 'Table not found' });
      }

      switch (method) {
        case 'GET':
          if (!hasPermission(user, config.name, 'read')) {
            return createResponse(403, { error: 'Forbidden' });
          }

          if (itemId) {
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
          const requiredFields = getRequiredFieldsByTableIndex(tableIndex);
          const validationErrors = validateRequiredFields(createBody, requiredFields);
          
          if (validationErrors.length > 0) {
            return createResponse(400, { error: 'Validation failed', details: validationErrors });
          }

          const newItem = {
            ...createBody,
            [config.pk]: createBody[config.pk] || randomUUID(),
            pk: config.entityType,
            sk: createBody[config.pk] || randomUUID(),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          };

          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: newItem
          }));

          await createAuditLog(user, 'CREATE', config.name, { itemId: newItem[config.pk] });

          return createResponse(201, newItem);

        case 'PUT':
          if (!itemId) {
            return createResponse(400, { error: 'Item ID required for update' });
          }

          if (!hasPermission(user, config.name, 'update')) {
            return createResponse(403, { error: 'Forbidden' });
          }

          const updateBody = JSON.parse(event.body || '{}');
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
            updatedAt: new Date().toISOString()
          };

          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: updatedItem
          }));

          await createAuditLog(user, 'UPDATE', config.name, { itemId });

          return createResponse(200, updatedItem);

        case 'DELETE':
          if (!itemId) {
            return createResponse(400, { error: 'Item ID required for delete' });
          }

          if (!hasPermission(user, config.name, 'delete')) {
            return createResponse(403, { error: 'Forbidden' });
          }

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

          await createAuditLog(user, 'DELETE', config.name, { itemId });

          return createResponse(200, { message: 'Item deleted successfully' });

        default:
          return createResponse(405, { error: 'Method not allowed' });
      }
    }

    return createResponse(404, { error: 'Endpoint not found' });

  } catch (error) {
    console.error('Error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};