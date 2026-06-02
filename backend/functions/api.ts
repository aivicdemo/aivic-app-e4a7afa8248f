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
  '2': { name: 'member_visits', pk: 'visitHistoryId', displayName: '会員来店履歴' },
  '3': { name: 'bottle_consumption', pk: 'consumptionHistoryId', displayName: 'キープボトル消費履歴' },
  '4': { name: 'demand_forecasts', pk: 'forecastReportId', displayName: '需要予測レポート' },
  '5': { name: 'monthly_aggregates', pk: 'aggregateId', displayName: '月次集計データ' },
  '6': { name: 'seasonal_analysis', pk: 'seasonalAnalysisId', displayName: '季節変動分析データ' },
  '7': { name: 'replenishment_plans', pk: 'replenishmentPlanId', displayName: '補充計画' },
  '8': { name: 'delivery_schedules', pk: 'deliveryScheduleId', displayName: '納品スケジュール' },
  '9': { name: 'delivery_routes', pk: 'deliveryRouteId', displayName: '配送ルート' },
  '10': { name: 'system_users', pk: 'userId', displayName: 'システム利用者' }
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

async function writeAuditLog(user: User, action: string, resource: string, details: any = {}) {
  const auditRecord = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    userId: user.id,
    userRole: user.role,
    action,
    resource,
    timestamp: new Date().toISOString(),
    details,
    createdAt: new Date().toISOString()
  };
  
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditRecord
  }));
}

function validateRequired(item: Record<string, any>, requiredFields: string[]): string[] {
  const errors: string[] = [];
  for (const field of requiredFields) {
    if (!item[field]) {
      errors.push(`${field} is required`);
    }
  }
  return errors;
}

function getRequiredFields(tableIndex: string): string[] {
  const fieldMap: Record<string, string[]> = {
    '0': ['storeCode', 'storeName', 'storeCategory', 'prefecture', 'city', 'transactionStartDate', 'transactionStatus', 'validFlag', 'creatorId', 'updaterId'],
    '1': ['storeId', 'customerName', 'productName', 'category', 'capacityMl', 'remainingMl', 'remainingPercent', 'keepStartDate', 'status', 'creator'],
    '2': ['memberId', 'storeId', 'visitDateTime', 'keepBottleUsedFlag', 'newBottleOrderFlag', 'creator'],
    '3': ['storeId', 'keepBottleId', 'memberId', 'consumptionDateTime', 'consumptionAmount', 'remainingAmount', 'completedFlag', 'creator'],
    '4': ['storeId', 'productCategory', 'forecastPeriodStart', 'forecastPeriodEnd', 'forecastDemand', 'confidenceLevel', 'seasonalFlag', 'eventFlag', 'recommendedPurchase', 'creator'],
    '5': ['storeId', 'aggregateMonth', 'productCategory', 'newKeepBottles', 'completedBottles', 'totalConsumption', 'totalVisitors', 'activeMembers', 'averageConsumption', 'creator'],
    '6': ['analysisYear', 'analysisMonth', 'alcoholCategory', 'regionCode', 'baseConsumption', 'actualConsumption', 'seasonalIndex', 'eventInfluenceFlag', 'creator'],
    '7': ['storeId', 'productCode', 'productName', 'planPeriodStart', 'planPeriodEnd', 'currentStock', 'forecastDemand', 'safetyStock', 'plannedReplenishment', 'scheduledDate', 'planStatus', 'priority', 'creator'],
    '8': ['storeId', 'productCode', 'productName', 'scheduledDeliveryDate', 'scheduledQuantity', 'deliveryStatus', 'creator'],
    '9': ['routeName', 'driverUserId', 'vehicleId', 'startLocation', 'endLocation', 'estimatedDuration', 'totalDistance', 'maxCapacity', 'deliveryDays', 'startTime', 'validFlag', 'creator'],
    '10': ['loginId', 'passwordHash', 'userName', 'email', 'permissionLevel', 'organization', 'accountStatus', 'creator']
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
    const pathParts = path.split('/').filter(Boolean);

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
      const config = TABLE_CONFIGS[tableIndex];
      const isBulkOperation = pathParts[2] === 'bulk';
      const itemId = pathParts[2] && pathParts[2] !== 'bulk' ? pathParts[2] : null;

      if (isBulkOperation && method === 'POST') {
        if (!hasPermission(user, config.name, 'bulk')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        const body = JSON.parse(event.body || '{}');
        const items = body.items || [];
        
        if (!Array.isArray(items)) {
          return createResponse(400, { error: 'Items must be an array' });
        }

        const requiredFields = getRequiredFields(tableIndex);
        let imported = 0;
        let failed = 0;
        const errors: string[] = [];
        const now = new Date().toISOString();

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

            const enrichedItem = {
              ...item,
              [config.pk]: item[config.pk] || randomUUID(),
              pk: config.name,
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

        await writeAuditLog(user, 'BULK_IMPORT', config.displayName, { imported, failed, totalItems: items.length });
        
        return createResponse(200, { imported, failed, errors });
      }

      switch (method) {
        case 'GET':
          if (!hasPermission(user, config.name, 'read')) {
            return createResponse(403, { error: 'Forbidden' });
          }

          if (itemId) {
            const result = await docClient.send(new GetCommand({
              TableName: TABLE_NAME,
              Key: { pk: config.name, sk: itemId }
            }));
            
            if (!result.Item) {
              return createResponse(404, { error: 'Item not found' });
            }
            
            return createResponse(200, { item: result.Item });
          } else {
            const result = await docClient.send(new ScanCommand({
              TableName: TABLE_NAME,
              FilterExpression: 'pk = :pk',
              ExpressionAttributeValues: { ':pk': config.name }
            }));
            
            return createResponse(200, { items: result.Items || [] });
          }

        case 'POST':
          if (!hasPermission(user, config.name, 'create')) {
            return createResponse(403, { error: 'Forbidden' });
          }

          const createBody = JSON.parse(event.body || '{}');
          const requiredFields = getRequiredFields(tableIndex);
          const validationErrors = validateRequired(createBody, requiredFields);
          
          if (validationErrors.length > 0) {
            return createResponse(400, { error: 'Validation failed', details: validationErrors });
          }

          const newItem = {
            ...createBody,
            [config.pk]: createBody[config.pk] || randomUUID(),
            pk: config.name,
            sk: createBody[config.pk] || randomUUID(),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          };

          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: newItem
          }));

          await writeAuditLog(user, 'CREATE', config.displayName, { itemId: newItem[config.pk] });
          
          return createResponse(201, { item: newItem });

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
            Key: { pk: config.name, sk: itemId }
          }));
          
          if (!existingItem.Item) {
            return createResponse(404, { error: 'Item not found' });
          }

          const updatedItem = {
            ...existingItem.Item,
            ...updateBody,
            [config.pk]: itemId,
            pk: config.name,
            sk: itemId,
            updatedAt: new Date().toISOString()
          };

          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: updatedItem
          }));

          await writeAuditLog(user, 'UPDATE', config.displayName, { itemId });
          
          return createResponse(200, { item: updatedItem });

        case 'DELETE':
          if (!itemId) {
            return createResponse(400, { error: 'Item ID required for delete' });
          }
          
          if (!hasPermission(user, config.name, 'delete')) {
            return createResponse(403, { error: 'Forbidden' });
          }

          const itemToDelete = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: { pk: config.name, sk: itemId }
          }));
          
          if (!itemToDelete.Item) {
            return createResponse(404, { error: 'Item not found' });
          }

          await docClient.send(new DeleteCommand({
            TableName: TABLE_NAME,
            Key: { pk: config.name, sk: itemId }
          }));

          await writeAuditLog(user, 'DELETE', config.displayName, { itemId });
          
          return createResponse(200, { message: 'Item deleted successfully' });

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