import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { hasPermission, extractUserFromEvent, User } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

const TABLE_CONFIGS = {
  '0': { name: 'stores', pk: 'storeId' },
  '1': { name: 'keepBottleInventory', pk: 'keepBottleId' },
  '2': { name: 'memberVisitHistory', pk: 'visitHistoryId' },
  '3': { name: 'keepBottleConsumptionHistory', pk: 'consumptionHistoryId' },
  '4': { name: 'demandForecastReport', pk: 'forecastReportId' },
  '5': { name: 'monthlyAggregateData', pk: 'aggregateId' },
  '6': { name: 'seasonalVariationAnalysis', pk: 'seasonalVariationAnalysisId' },
  '7': { name: 'replenishmentPlan', pk: 'replenishmentPlanId' },
  '8': { name: 'deliverySchedule', pk: 'deliveryScheduleId' },
  '9': { name: 'deliveryRoute', pk: 'deliveryRouteId' },
  '10': { name: 'systemUsers', pk: 'userId' }
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

function createAuditLog(user: User, action: string, resource: string, details?: any) {
  return {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    userId: user.id,
    userRole: user.role,
    action,
    resource,
    details,
    timestamp: new Date().toISOString()
  };
}

async function writeAuditLog(user: User, action: string, resource: string, details?: any) {
  try {
    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: createAuditLog(user, action, resource, details)
    }));
  } catch (error) {
    console.error('Failed to write audit log:', error);
  }
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

function getRequiredFields(tableIndex: string): string[] {
  const fieldMap: Record<string, string[]> = {
    '0': ['storeCode', 'storeName', 'storeCategory', 'prefecture', 'city', 'transactionStartDate', 'transactionStatus', 'isActive'],
    '1': ['storeId', 'customerName', 'productName', 'category', 'capacityMl', 'remainingMl', 'remainingPercentage', 'keepStartDate', 'status'],
    '2': ['memberId', 'storeId', 'visitDateTime', 'keepBottleUsed', 'newBottleOrdered'],
    '3': ['storeId', 'keepBottleId', 'memberId', 'consumptionDateTime', 'consumptionAmount', 'remainingAmount', 'isFinished'],
    '4': ['storeId', 'productCategory', 'forecastPeriodStart', 'forecastPeriodEnd', 'forecastDemand', 'confidenceLevel', 'seasonalFactor', 'eventFactor', 'recommendedPurchaseAmount'],
    '5': ['storeId', 'aggregateYearMonth', 'productCategory', 'newKeepBottles', 'completedBottles', 'totalConsumption', 'totalVisitors', 'activeMembers', 'averageConsumption'],
    '6': ['analysisYear', 'analysisMonth', 'alcoholCategory', 'regionCode', 'baseConsumption', 'actualConsumption', 'seasonalIndex', 'eventInfluence'],
    '7': ['storeId', 'productCode', 'productName', 'planPeriodStart', 'planPeriodEnd', 'currentStock', 'forecastDemand', 'safetyStock', 'plannedReplenishment', 'scheduledDate', 'planStatus', 'priority'],
    '8': ['storeId', 'productCode', 'productName', 'scheduledDeliveryDate', 'scheduledQuantity', 'deliveryStatus'],
    '9': ['routeName', 'driverId', 'vehicleId', 'startLocation', 'endLocation', 'estimatedDuration', 'totalDistance', 'maxCapacity', 'deliveryDays', 'startTime', 'isActive'],
    '10': ['loginId', 'passwordHash', 'userName', 'email', 'permissionLevel', 'organization', 'accountStatus']
  };
  return fieldMap[tableIndex] || [];
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
    const method = event.httpMethod || event.requestContext?.http?.method || 'GET';
    const pathParts = path.split('/').filter(p => p);

    if (pathParts[0] === 'resources') {
      if (method === 'GET') {
        if (!hasPermission(user, 'resources', 'read')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        const resources = Object.entries(TABLE_CONFIGS).map(([index, config]) => ({
          index,
          name: config.name,
          primaryKey: config.pk
        }));

        return createResponse(200, { resources });
      }
    }

    if (pathParts[0] === 'api' && pathParts[1] && TABLE_CONFIGS[pathParts[1]]) {
      const tableIndex = pathParts[1];
      const tableConfig = TABLE_CONFIGS[tableIndex];
      const isBulkOperation = pathParts[2] === 'bulk';
      const itemId = pathParts[2] && !isBulkOperation ? pathParts[2] : null;

      if (method === 'GET' && !itemId && !isBulkOperation) {
        if (!hasPermission(user, tableConfig.name, 'read')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        try {
          const result = await docClient.send(new ScanCommand({
            TableName: TABLE_NAME,
            FilterExpression: 'begins_with(pk, :pkPrefix)',
            ExpressionAttributeValues: {
              ':pkPrefix': `${tableConfig.name}#`
            }
          }));

          return createResponse(200, { items: result.Items || [] });
        } catch (error) {
          console.error('Scan error:', error);
          return createResponse(500, { error: 'Internal server error' });
        }
      }

      if (method === 'GET' && itemId) {
        if (!hasPermission(user, tableConfig.name, 'read')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        try {
          const result = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: `${tableConfig.name}#${itemId}`,
              sk: 'ITEM'
            }
          }));

          if (!result.Item) {
            return createResponse(404, { error: 'Item not found' });
          }

          return createResponse(200, result.Item);
        } catch (error) {
          console.error('Get error:', error);
          return createResponse(500, { error: 'Internal server error' });
        }
      }

      if (method === 'POST' && !itemId && !isBulkOperation) {
        if (!hasPermission(user, tableConfig.name, 'create')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        let requestBody;
        try {
          requestBody = JSON.parse(event.body || '{}');
        } catch {
          return createResponse(400, { error: 'Invalid JSON' });
        }

        const requiredFields = getRequiredFields(tableIndex);
        const validationErrors = validateRequired(requestBody, requiredFields);
        if (validationErrors.length > 0) {
          return createResponse(400, { error: 'Validation failed', details: validationErrors });
        }

        const id = requestBody[tableConfig.pk] || randomUUID();
        const now = new Date().toISOString();
        const item = {
          ...requestBody,
          [tableConfig.pk]: id,
          pk: `${tableConfig.name}#${id}`,
          sk: 'ITEM',
          createdAt: now,
          updatedAt: now,
          createdBy: user.id,
          updatedBy: user.id
        };

        try {
          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: item
          }));

          await writeAuditLog(user, 'CREATE', tableConfig.name, { id });

          return createResponse(201, item);
        } catch (error) {
          console.error('Put error:', error);
          return createResponse(500, { error: 'Internal server error' });
        }
      }

      if (method === 'POST' && isBulkOperation) {
        if (!hasPermission(user, tableConfig.name, 'bulk')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        let requestBody;
        try {
          requestBody = JSON.parse(event.body || '{}');
        } catch {
          return createResponse(400, { error: 'Invalid JSON' });
        }

        if (!Array.isArray(requestBody.items)) {
          return createResponse(400, { error: 'items must be an array' });
        }

        const items = requestBody.items;
        const requiredFields = getRequiredFields(tableIndex);
        let imported = 0;
        let failed = 0;
        const errors: string[] = [];

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

            const id = item[tableConfig.pk] || randomUUID();
            const now = new Date().toISOString();
            const processedItem = {
              ...item,
              [tableConfig.pk]: id,
              pk: `${tableConfig.name}#${id}`,
              sk: 'ITEM',
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
              console.error('Batch write error:', error);
              failed += writeRequests.length;
              errors.push(`Batch ${Math.floor(i / 25)}: Database error`);
            }
          }
        }

        await writeAuditLog(user, 'BULK_CREATE', tableConfig.name, { imported, failed });

        return createResponse(200, { imported, failed, errors });
      }

      if (method === 'PUT' && itemId) {
        if (!hasPermission(user, tableConfig.name, 'update')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        let requestBody;
        try {
          requestBody = JSON.parse(event.body || '{}');
        } catch {
          return createResponse(400, { error: 'Invalid JSON' });
        }

        const requiredFields = getRequiredFields(tableIndex);
        const validationErrors = validateRequired(requestBody, requiredFields);
        if (validationErrors.length > 0) {
          return createResponse(400, { error: 'Validation failed', details: validationErrors });
        }

        try {
          const existing = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: `${tableConfig.name}#${itemId}`,
              sk: 'ITEM'
            }
          }));

          if (!existing.Item) {
            return createResponse(404, { error: 'Item not found' });
          }

          const updatedItem = {
            ...existing.Item,
            ...requestBody,
            [tableConfig.pk]: itemId,
            updatedAt: new Date().toISOString(),
            updatedBy: user.id
          };

          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: updatedItem
          }));

          await writeAuditLog(user, 'UPDATE', tableConfig.name, { id: itemId });

          return createResponse(200, updatedItem);
        } catch (error) {
          console.error('Update error:', error);
          return createResponse(500, { error: 'Internal server error' });
        }
      }

      if (method === 'DELETE' && itemId) {
        if (!hasPermission(user, tableConfig.name, 'delete')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        try {
          const existing = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: `${tableConfig.name}#${itemId}`,
              sk: 'ITEM'
            }
          }));

          if (!existing.Item) {
            return createResponse(404, { error: 'Item not found' });
          }

          await docClient.send(new DeleteCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: `${tableConfig.name}#${itemId}`,
              sk: 'ITEM'
            }
          }));

          await writeAuditLog(user, 'DELETE', tableConfig.name, { id: itemId });

          return createResponse(200, { message: 'Item deleted successfully' });
        } catch (error) {
          console.error('Delete error:', error);
          return createResponse(500, { error: 'Internal server error' });
        }
      }
    }

    return createResponse(404, { error: 'Not found' });
  } catch (error) {
    console.error('Handler error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};