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
  '2': { name: 'visit_history', pk: 'visitHistoryId', entityType: 'VISIT_HISTORY' },
  '3': { name: 'consumption_history', pk: 'consumptionHistoryId', entityType: 'CONSUMPTION_HISTORY' },
  '4': { name: 'demand_forecast', pk: 'forecastReportId', entityType: 'DEMAND_FORECAST' },
  '5': { name: 'monthly_summary', pk: 'summaryId', entityType: 'MONTHLY_SUMMARY' },
  '6': { name: 'seasonal_analysis', pk: 'seasonalAnalysisId', entityType: 'SEASONAL_ANALYSIS' },
  '7': { name: 'replenishment_plan', pk: 'replenishmentPlanId', entityType: 'REPLENISHMENT_PLAN' },
  '8': { name: 'delivery_schedule', pk: 'deliveryScheduleId', entityType: 'DELIVERY_SCHEDULE' },
  '9': { name: 'delivery_route', pk: 'deliveryRouteId', entityType: 'DELIVERY_ROUTE' },
  '10': { name: 'system_users', pk: 'userId', entityType: 'SYSTEM_USER' }
};

interface APIGatewayEvent {
  httpMethod: string;
  pathParameters: { [key: string]: string } | null;
  queryStringParameters: { [key: string]: string } | null;
  body: string | null;
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
    'STORE': ['storeCode', 'storeName', 'storeCategory', 'prefecture', 'city', 'transactionStartDate', 'transactionStatus', 'isActive', 'createdBy', 'updatedBy'],
    'KEEP_BOTTLE': ['storeId', 'customerName', 'productName', 'category', 'capacityMl', 'remainingMl', 'remainingPercent', 'keepStartDate', 'status'],
    'VISIT_HISTORY': ['memberId', 'storeId', 'visitDateTime', 'keepBottleUsed', 'newBottleOrdered'],
    'CONSUMPTION_HISTORY': ['storeId', 'keepBottleId', 'memberId', 'consumptionDateTime', 'consumptionAmount', 'remainingAmount', 'isFinished'],
    'DEMAND_FORECAST': ['storeId', 'productCategory', 'forecastPeriodStart', 'forecastPeriodEnd', 'predictedDemand', 'confidenceLevel', 'seasonalFactor', 'eventFactor', 'recommendedPurchase'],
    'MONTHLY_SUMMARY': ['storeId', 'summaryMonth', 'productCategory', 'newKeepBottles', 'completedBottles', 'totalConsumption', 'visitCount', 'activeMemberCount', 'averageConsumption'],
    'SEASONAL_ANALYSIS': ['analysisYear', 'analysisMonth', 'alcoholCategory', 'regionCode', 'baseConsumption', 'actualConsumption', 'seasonalIndex', 'eventInfluence', 'temperatureInfluence'],
    'REPLENISHMENT_PLAN': ['storeId', 'productCode', 'productName', 'planPeriodStart', 'planPeriodEnd', 'currentStock', 'predictedDemand', 'safetyStock', 'plannedReplenishment', 'scheduledDate', 'planStatus', 'priority'],
    'DELIVERY_SCHEDULE': ['storeId', 'productCode', 'productName', 'scheduledDeliveryDate', 'scheduledQuantity', 'deliveryStatus'],
    'DELIVERY_ROUTE': ['routeName', 'driverId', 'vehicleId', 'startPoint', 'endPoint', 'estimatedDuration', 'totalDistance', 'maxCapacity', 'deliveryDays', 'startTime', 'isActive'],
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

    const path = event.pathParameters?.proxy || '';
    const pathParts = path.split('/');
    
    if (pathParts[0] === 'resources') {
      if (event.httpMethod === 'GET') {
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
    }

    const tableIndex = pathParts[0];
    const tableConfig = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    
    if (!tableConfig) {
      return createResponse(404, { error: 'Resource not found' });
    }

    const resourceId = pathParts[1];
    const isBulkOperation = pathParts[1] === 'bulk';

    if (isBulkOperation && event.httpMethod === 'POST') {
      if (!hasPermission(user, tableConfig.name, 'bulk')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      let requestBody;
      try {
        requestBody = JSON.parse(event.body || '{}');
      } catch (error) {
        return createResponse(400, { error: 'Invalid JSON' });
      }

      const items = requestBody.items || [];
      if (!Array.isArray(items)) {
        return createResponse(400, { error: 'items must be an array' });
      }

      let imported = 0;
      let failed = 0;
      const errors: string[] = [];
      const requiredFields = getRequiredFieldsByEntityType(tableConfig.entityType);

      const chunks = [];
      for (let i = 0; i < items.length; i += 25) {
        chunks.push(items.slice(i, i + 25));
      }

      for (const chunk of chunks) {
        const writeRequests = [];
        
        for (const item of chunk) {
          const validationErrors = validateRequiredFields(item, requiredFields);
          if (validationErrors.length > 0) {
            failed++;
            errors.push(`Item validation failed: ${validationErrors.join(', ')}`);
            continue;
          }

          const now = new Date().toISOString();
          const processedItem = {
            ...item,
            [tableConfig.pk]: item[tableConfig.pk] || randomUUID(),
            pk: tableConfig.entityType,
            sk: item[tableConfig.pk] || randomUUID(),
            entityType: tableConfig.entityType,
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

      await createAuditLog(user, 'BULK_IMPORT', tableConfig.name, { imported, failed, totalItems: items.length });

      return createResponse(200, { imported, failed, errors });
    }

    switch (event.httpMethod) {
      case 'GET':
        if (!hasPermission(user, tableConfig.name, 'read')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        if (resourceId) {
          const result = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: tableConfig.entityType,
              sk: resourceId
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
            count: result.Count || 0,
            lastEvaluatedKey: result.LastEvaluatedKey
          });
        }

      case 'POST':
        if (!hasPermission(user, tableConfig.name, 'create')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        let createBody;
        try {
          createBody = JSON.parse(event.body || '{}');
        } catch (error) {
          return createResponse(400, { error: 'Invalid JSON' });
        }

        const createValidationErrors = validateRequiredFields(createBody, getRequiredFieldsByEntityType(tableConfig.entityType));
        if (createValidationErrors.length > 0) {
          return createResponse(400, { error: 'Validation failed', details: createValidationErrors });
        }

        const newId = randomUUID();
        const now = new Date().toISOString();
        const newItem = {
          ...createBody,
          [tableConfig.pk]: newId,
          pk: tableConfig.entityType,
          sk: newId,
          entityType: tableConfig.entityType,
          createdAt: now,
          updatedAt: now,
          createdBy: user.id,
          updatedBy: user.id
        };

        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: newItem
        }));

        await createAuditLog(user, 'CREATE', tableConfig.name, { id: newId });

        return createResponse(201, newItem);

      case 'PUT':
        if (!resourceId) {
          return createResponse(400, { error: 'Resource ID required' });
        }

        if (!hasPermission(user, tableConfig.name, 'update')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        let updateBody;
        try {
          updateBody = JSON.parse(event.body || '{}');
        } catch (error) {
          return createResponse(400, { error: 'Invalid JSON' });
        }

        const existingItem = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: tableConfig.entityType,
            sk: resourceId
          }
        }));

        if (!existingItem.Item) {
          return createResponse(404, { error: 'Item not found' });
        }

        const updatedItem = {
          ...existingItem.Item,
          ...updateBody,
          [tableConfig.pk]: resourceId,
          pk: tableConfig.entityType,
          sk: resourceId,
          entityType: tableConfig.entityType,
          updatedAt: new Date().toISOString(),
          updatedBy: user.id
        };

        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: updatedItem
        }));

        await createAuditLog(user, 'UPDATE', tableConfig.name, { id: resourceId });

        return createResponse(200, updatedItem);

      case 'DELETE':
        if (!resourceId) {
          return createResponse(400, { error: 'Resource ID required' });
        }

        if (!hasPermission(user, tableConfig.name, 'delete')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        const itemToDelete = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: tableConfig.entityType,
            sk: resourceId
          }
        }));

        if (!itemToDelete.Item) {
          return createResponse(404, { error: 'Item not found' });
        }

        await docClient.send(new DeleteCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: tableConfig.entityType,
            sk: resourceId
          }
        }));

        await createAuditLog(user, 'DELETE', tableConfig.name, { id: resourceId });

        return createResponse(200, { message: 'Item deleted successfully' });

      default:
        return createResponse(405, { error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};