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
    '0': ['storeCode', 'storeName', 'storeCategory', 'prefecture', 'city', 'transactionStartDate', 'transactionStatus', 'validFlag', 'createdBy', 'updatedBy'],
    '1': ['storeId', 'customerName', 'productName', 'category', 'capacityMl', 'remainingMl', 'remainingPercent', 'keepStartDate', 'status', 'createdBy'],
    '2': ['memberId', 'storeId', 'visitDateTime', 'keepBottleUsedFlag', 'newBottleOrderFlag', 'createdBy'],
    '3': ['storeId', 'keepBottleId', 'memberId', 'consumptionDateTime', 'consumptionAmount', 'remainingAmount', 'completedFlag', 'createdBy'],
    '4': ['storeId', 'productCategory', 'forecastPeriodStart', 'forecastPeriodEnd', 'forecastDemand', 'confidenceLevel', 'seasonalFlag', 'eventFlag', 'recommendedPurchase', 'createdBy'],
    '5': ['storeId', 'summaryMonth', 'productCategory', 'newKeepBottles', 'completedBottles', 'totalConsumption', 'visitCount', 'activeMemberCount', 'averageConsumption', 'createdBy'],
    '6': ['analysisYear', 'analysisMonth', 'alcoholCategory', 'regionCode', 'baseConsumption', 'actualConsumption', 'seasonalIndex', 'eventInfluenceFlag', 'createdBy'],
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
    const pathParts = path.split('/').filter(p => p);

    if (pathParts[0] === 'resources') {
      if (method === 'GET') {
        if (!hasPermission(user, 'resources', 'read')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        const resources = Object.entries(TABLE_CONFIGS).map(([index, config]) => ({
          index,
          name: config.name,
          displayName: config.displayName,
          primaryKey: config.pk
        }));

        return createResponse(200, { resources });
      }
    }

    if (pathParts[0] === 'api' && pathParts[1] && TABLE_CONFIGS[pathParts[1]]) {
      const tableIndex = pathParts[1];
      const tableConfig = TABLE_CONFIGS[tableIndex];
      const resourceName = tableConfig.name;

      if (pathParts[2] === 'bulk' && method === 'POST') {
        if (!hasPermission(user, resourceName, 'bulk')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        const body = JSON.parse(event.body || '{}');
        const items = body.items || [];

        if (!Array.isArray(items)) {
          return createResponse(400, { error: 'items must be an array' });
        }

        let imported = 0;
        let failed = 0;
        const errors: string[] = [];
        const requiredFields = getRequiredFieldsByTableIndex(tableIndex);

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

            const enrichedItem = {
              ...item,
              pk: resourceName,
              sk: item[tableConfig.pk] || randomUUID(),
              [tableConfig.pk]: item[tableConfig.pk] || randomUUID(),
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
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

        await createAuditLog(user, 'BULK_IMPORT', resourceName, { imported, failed, totalItems: items.length });

        return createResponse(200, { imported, failed, errors });
      }

      if (method === 'GET') {
        if (!hasPermission(user, resourceName, 'read')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        if (pathParts[2]) {
          const id = pathParts[2];
          const result = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: { pk: resourceName, sk: id }
          }));

          if (!result.Item) {
            return createResponse(404, { error: 'Item not found' });
          }

          return createResponse(200, result.Item);
        } else {
          const limit = event.queryStringParameters?.limit ? parseInt(event.queryStringParameters.limit) : 100;
          const result = await docClient.send(new ScanCommand({
            TableName: TABLE_NAME,
            FilterExpression: 'pk = :pk',
            ExpressionAttributeValues: { ':pk': resourceName },
            Limit: limit
          }));

          return createResponse(200, {
            items: result.Items || [],
            count: result.Count || 0,
            lastEvaluatedKey: result.LastEvaluatedKey
          });
        }
      }

      if (method === 'POST') {
        if (!hasPermission(user, resourceName, 'create')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        const body = JSON.parse(event.body || '{}');
        const requiredFields = getRequiredFieldsByTableIndex(tableIndex);
        const validationErrors = validateRequiredFields(body, requiredFields);

        if (validationErrors.length > 0) {
          return createResponse(400, { error: 'Validation failed', details: validationErrors });
        }

        const id = randomUUID();
        const item = {
          ...body,
          pk: resourceName,
          sk: id,
          [tableConfig.pk]: id,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };

        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: item
        }));

        await createAuditLog(user, 'CREATE', resourceName, { id });

        return createResponse(201, item);
      }

      if (method === 'PUT' && pathParts[2]) {
        if (!hasPermission(user, resourceName, 'update')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        const id = pathParts[2];
        const body = JSON.parse(event.body || '{}');

        const existingItem = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: { pk: resourceName, sk: id }
        }));

        if (!existingItem.Item) {
          return createResponse(404, { error: 'Item not found' });
        }

        const updatedItem = {
          ...existingItem.Item,
          ...body,
          updatedAt: new Date().toISOString()
        };

        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: updatedItem
        }));

        await createAuditLog(user, 'UPDATE', resourceName, { id });

        return createResponse(200, updatedItem);
      }

      if (method === 'DELETE' && pathParts[2]) {
        if (!hasPermission(user, resourceName, 'delete')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        const id = pathParts[2];

        const existingItem = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: { pk: resourceName, sk: id }
        }));

        if (!existingItem.Item) {
          return createResponse(404, { error: 'Item not found' });
        }

        await docClient.send(new DeleteCommand({
          TableName: TABLE_NAME,
          Key: { pk: resourceName, sk: id }
        }));

        await createAuditLog(user, 'DELETE', resourceName, { id });

        return createResponse(200, { message: 'Item deleted successfully' });
      }
    }

    return createResponse(404, { error: 'Not found' });

  } catch (error) {
    console.error('Error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};