import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { hasPermission, extractUserFromEvent, User } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

const tableConfigs = {
  0: { name: 'stores', pk: 'storeId', entityType: 'STORE' },
  1: { name: 'keepBottleInventory', pk: 'keepBottleId', entityType: 'KEEP_BOTTLE' },
  2: { name: 'memberVisitHistory', pk: 'visitHistoryId', entityType: 'VISIT_HISTORY' },
  3: { name: 'keepBottleConsumptionHistory', pk: 'consumptionHistoryId', entityType: 'CONSUMPTION_HISTORY' },
  4: { name: 'demandForecastReport', pk: 'forecastReportId', entityType: 'FORECAST_REPORT' },
  5: { name: 'monthlyAggregateData', pk: 'aggregateId', entityType: 'MONTHLY_AGGREGATE' },
  6: { name: 'seasonalVariationAnalysis', pk: 'seasonalVariationAnalysisId', entityType: 'SEASONAL_ANALYSIS' },
  7: { name: 'replenishmentPlan', pk: 'replenishmentPlanId', entityType: 'REPLENISHMENT_PLAN' },
  8: { name: 'deliverySchedule', pk: 'deliveryScheduleId', entityType: 'DELIVERY_SCHEDULE' },
  9: { name: 'deliveryRoute', pk: 'deliveryRouteId', entityType: 'DELIVERY_ROUTE' },
  10: { name: 'systemUsers', pk: 'userId', entityType: 'SYSTEM_USER' }
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

function validateRequired(item: any, requiredFields: string[]): string[] {
  const errors: string[] = [];
  for (const field of requiredFields) {
    if (item[field] === undefined || item[field] === null || item[field] === '') {
      errors.push(`${field} is required`);
    }
  }
  return errors;
}

function getRequiredFields(entityType: string): string[] {
  const fieldMap: { [key: string]: string[] } = {
    'STORE': ['storeCode', 'storeName', 'storeCategory', 'prefecture', 'city', 'transactionStartDate', 'transactionStatus', 'validFlag'],
    'KEEP_BOTTLE': ['storeId', 'customerName', 'productName', 'category', 'capacityMl', 'remainingMl', 'remainingPercent', 'keepStartDate', 'status'],
    'VISIT_HISTORY': ['memberId', 'storeId', 'visitDateTime', 'keepBottleUsedFlag', 'newBottleOrderFlag'],
    'CONSUMPTION_HISTORY': ['storeId', 'keepBottleId', 'memberId', 'consumptionDateTime', 'consumptionAmount', 'remainingAmount', 'completedFlag'],
    'FORECAST_REPORT': ['storeId', 'productCategory', 'forecastPeriodStart', 'forecastPeriodEnd', 'forecastDemand', 'confidenceLevel', 'seasonalFactorFlag', 'eventFactorFlag', 'recommendedPurchaseAmount'],
    'MONTHLY_AGGREGATE': ['storeId', 'aggregateYearMonth', 'productCategory', 'newKeepBottles', 'completedBottles', 'totalConsumption', 'visitorCount', 'activeMemberCount', 'averageConsumption'],
    'SEASONAL_ANALYSIS': ['analysisYear', 'analysisMonth', 'alcoholCategory', 'regionCode', 'baseConsumption', 'actualConsumption', 'seasonalIndex', 'eventInfluenceFlag', 'temperatureInfluence'],
    'REPLENISHMENT_PLAN': ['storeId', 'productCode', 'productName', 'planPeriodStart', 'planPeriodEnd', 'currentStock', 'forecastDemand', 'safetyStock', 'plannedReplenishment', 'scheduledReplenishmentDate', 'planStatus', 'priority'],
    'DELIVERY_SCHEDULE': ['storeId', 'productCode', 'productName', 'scheduledDeliveryDate', 'scheduledQuantity', 'deliveryStatus'],
    'DELIVERY_ROUTE': ['routeName', 'driverId', 'vehicleId', 'startLocation', 'endLocation', 'estimatedDuration', 'totalDistance', 'maxCapacity', 'deliveryDays', 'startTime', 'validFlag'],
    'SYSTEM_USER': ['loginId', 'passwordHash', 'userName', 'email', 'permissionLevel', 'organization', 'accountStatus']
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

    const pathParts = event.path.split('/').filter(p => p);
    
    if (pathParts[0] === 'resources') {
      if (event.httpMethod === 'GET') {
        if (!hasPermission(user, 'resources', 'read')) {
          return createResponse(403, { error: 'Forbidden' });
        }
        
        const resources = Object.entries(tableConfigs).map(([index, config]) => ({
          index: parseInt(index),
          name: config.name,
          entityType: config.entityType
        }));
        
        return createResponse(200, { resources });
      }
    }

    if (pathParts[0] === 'api' && pathParts[1] && tableConfigs[parseInt(pathParts[1])]) {
      const tableIndex = parseInt(pathParts[1]);
      const config = tableConfigs[tableIndex];
      const isBulkEndpoint = pathParts[2] === 'bulk';
      const resourceId = pathParts[2] && pathParts[2] !== 'bulk' ? pathParts[2] : null;

      if (isBulkEndpoint && event.httpMethod === 'POST') {
        if (!hasPermission(user, config.name, 'bulk')) {
          return createResponse(403, { error: 'Forbidden' });
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
        const now = new Date().toISOString();
        const requiredFields = getRequiredFields(config.entityType);

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

            const processedItem = {
              ...item,
              [config.pk]: item[config.pk] || randomUUID(),
              pk: config.entityType,
              sk: item[config.pk] || randomUUID(),
              entityType: config.entityType,
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

        await writeAuditLog(user, 'BULK_IMPORT', config.name, { imported, failed, totalItems: items.length });

        return createResponse(200, { imported, failed, errors });
      }

      switch (event.httpMethod) {
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
              return createResponse(404, { error: 'Resource not found' });
            }

            return createResponse(200, result.Item);
          } else {
            const limit = event.queryStringParameters?.limit ? parseInt(event.queryStringParameters.limit) : 50;
            const result = await docClient.send(new ScanCommand({
              TableName: TABLE_NAME,
              FilterExpression: 'pk = :pk',
              ExpressionAttributeValues: {
                ':pk': config.entityType
              },
              Limit: Math.min(limit, 100)
            }));

            return createResponse(200, {
              items: result.Items || [],
              count: result.Count || 0,
              lastEvaluatedKey: result.LastEvaluatedKey
            });
          }

        case 'POST':
          if (!hasPermission(user, config.name, 'create')) {
            return createResponse(403, { error: 'Forbidden' });
          }

          let createBody;
          try {
            createBody = JSON.parse(event.body || '{}');
          } catch (error) {
            return createResponse(400, { error: 'Invalid JSON in request body' });
          }

          const createValidationErrors = validateRequired(createBody, getRequiredFields(config.entityType));
          if (createValidationErrors.length > 0) {
            return createResponse(400, { error: 'Validation failed', details: createValidationErrors });
          }

          const newId = randomUUID();
          const now = new Date().toISOString();
          const newItem = {
            ...createBody,
            [config.pk]: newId,
            pk: config.entityType,
            sk: newId,
            entityType: config.entityType,
            createdAt: now,
            updatedAt: now,
            createdBy: user.id,
            updatedBy: user.id
          };

          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: newItem
          }));

          await writeAuditLog(user, 'CREATE', config.name, { id: newId });

          return createResponse(201, newItem);

        case 'PUT':
          if (!resourceId) {
            return createResponse(400, { error: 'Resource ID is required for PUT operations' });
          }

          if (!hasPermission(user, config.name, 'update')) {
            return createResponse(403, { error: 'Forbidden' });
          }

          let updateBody;
          try {
            updateBody = JSON.parse(event.body || '{}');
          } catch (error) {
            return createResponse(400, { error: 'Invalid JSON in request body' });
          }

          const existingItem = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: config.entityType,
              sk: resourceId
            }
          }));

          if (!existingItem.Item) {
            return createResponse(404, { error: 'Resource not found' });
          }

          const updateValidationErrors = validateRequired(updateBody, getRequiredFields(config.entityType));
          if (updateValidationErrors.length > 0) {
            return createResponse(400, { error: 'Validation failed', details: updateValidationErrors });
          }

          const updatedItem = {
            ...existingItem.Item,
            ...updateBody,
            [config.pk]: resourceId,
            pk: config.entityType,
            sk: resourceId,
            updatedAt: new Date().toISOString(),
            updatedBy: user.id
          };

          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: updatedItem
          }));

          await writeAuditLog(user, 'UPDATE', config.name, { id: resourceId });

          return createResponse(200, updatedItem);

        case 'DELETE':
          if (!resourceId) {
            return createResponse(400, { error: 'Resource ID is required for DELETE operations' });
          }

          if (!hasPermission(user, config.name, 'delete')) {
            return createResponse(403, { error: 'Forbidden' });
          }

          const itemToDelete = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: config.entityType,
              sk: resourceId
            }
          }));

          if (!itemToDelete.Item) {
            return createResponse(404, { error: 'Resource not found' });
          }

          await docClient.send(new DeleteCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: config.entityType,
              sk: resourceId
            }
          }));

          await writeAuditLog(user, 'DELETE', config.name, { id: resourceId });

          return createResponse(200, { message: 'Resource deleted successfully' });

        default:
          return createResponse(405, { error: 'Method not allowed' });
      }
    }

    return createResponse(404, { error: 'Endpoint not found' });

  } catch (error) {
    console.error('Handler error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};