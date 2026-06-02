import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { hasPermission, extractUserFromEvent, User } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

const TABLE_CONFIGS = {
  '0': { name: 'stores', pk: 'storeId', description: '店舗マスタ' },
  '1': { name: 'keep_bottles', pk: 'keepBottleId', description: 'キープボトル在庫' },
  '2': { name: 'visit_history', pk: 'visitHistoryId', description: '会員来店履歴' },
  '3': { name: 'consumption_history', pk: 'consumptionHistoryId', description: 'キープボトル消費履歴' },
  '4': { name: 'demand_forecast', pk: 'forecastReportId', description: '需要予測レポート' },
  '5': { name: 'monthly_summary', pk: 'summaryId', description: '月次集計データ' },
  '6': { name: 'seasonal_analysis', pk: 'seasonalAnalysisId', description: '季節変動分析データ' },
  '7': { name: 'replenishment_plan', pk: 'replenishmentPlanId', description: '補充計画' },
  '8': { name: 'delivery_schedule', pk: 'deliveryScheduleId', description: '納品スケジュール' },
  '9': { name: 'delivery_route', pk: 'deliveryRouteId', description: '配送ルート' },
  '10': { name: 'system_users', pk: 'userId', description: 'システム利用者' }
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
    if (!item[field]) {
      errors.push(`${field} is required`);
    }
  }
  return errors;
}

function getRequiredFields(tableIndex: string): string[] {
  const fieldMap: Record<string, string[]> = {
    '0': ['storeCode', 'storeName', 'storeCategory', 'prefecture', 'city', 'transactionStartDate', 'transactionStatus', 'isActive', 'createdBy', 'updatedBy'],
    '1': ['storeId', 'customerName', 'productName', 'category', 'capacityMl', 'remainingMl', 'remainingPercent', 'keepStartDate', 'status', 'createdBy'],
    '2': ['memberId', 'storeId', 'visitDateTime', 'keepBottleUsed', 'newBottleOrdered', 'createdBy'],
    '3': ['storeId', 'keepBottleId', 'memberId', 'consumptionDateTime', 'consumptionAmount', 'remainingAmount', 'isCompleted', 'createdBy'],
    '4': ['storeId', 'productCategory', 'forecastPeriodStart', 'forecastPeriodEnd', 'forecastDemand', 'confidenceLevel', 'seasonalFactor', 'eventFactor', 'recommendedPurchase', 'createdBy'],
    '5': ['storeId', 'summaryMonth', 'productCategory', 'newKeepBottles', 'completedBottles', 'totalConsumption', 'visitCount', 'activeMemberCount', 'averageConsumption', 'createdBy'],
    '6': ['analysisYear', 'analysisMonth', 'alcoholCategory', 'regionCode', 'baseConsumption', 'actualConsumption', 'seasonalIndex', 'eventImpact', 'createdBy'],
    '7': ['storeId', 'productCode', 'productName', 'planPeriodStart', 'planPeriodEnd', 'currentStock', 'forecastDemand', 'safetyStock', 'plannedReplenishment', 'scheduledDate', 'planStatus', 'priority', 'createdBy'],
    '8': ['storeId', 'productCode', 'productName', 'scheduledDeliveryDate', 'scheduledQuantity', 'deliveryStatus', 'createdBy'],
    '9': ['routeName', 'driverId', 'vehicleId', 'startLocation', 'endLocation', 'estimatedDuration', 'totalDistance', 'maxCapacity', 'deliveryDays', 'startTime', 'isActive', 'createdBy'],
    '10': ['loginId', 'passwordHash', 'userName', 'email', 'permissionLevel', 'organization', 'accountStatus', 'createdBy']
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
    const pathParams = event.pathParameters || {};
    const queryParams = event.queryStringParameters || {};
    
    let body: any = {};
    if (event.body) {
      try {
        body = JSON.parse(event.body);
      } catch (error) {
        return createResponse(400, { error: 'Invalid JSON body' });
      }
    }

    // GET /resources - システムリソース一覧
    if (path === '/resources' && method === 'GET') {
      if (!hasPermission(user, 'system', 'read')) {
        return createResponse(403, { error: 'Forbidden' });
      }
      
      return createResponse(200, {
        tables: Object.entries(TABLE_CONFIGS).map(([index, config]) => ({
          index,
          name: config.name,
          description: config.description,
          endpoints: {
            list: `/api/${index}`,
            detail: `/api/${index}/{id}`,
            bulk: `/api/${index}/bulk`
          }
        }))
      });
    }

    // API routes: /api/{tableIndex}/*
    const apiMatch = path.match(/^\/api\/(\d+)(?:\/(.+))?$/);
    if (!apiMatch) {
      return createResponse(404, { error: 'Not found' });
    }

    const [, tableIndex, subPath] = apiMatch;
    const tableConfig = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    
    if (!tableConfig) {
      return createResponse(404, { error: 'Table not found' });
    }

    const pkField = tableConfig.pk;
    const tableName = tableConfig.name;

    // Bulk import: POST /api/{tableIndex}/bulk
    if (subPath === 'bulk' && method === 'POST') {
      if (!hasPermission(user, tableName, 'bulk')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      if (!body.items || !Array.isArray(body.items)) {
        return createResponse(400, { error: 'items array is required' });
      }

      const requiredFields = getRequiredFields(tableIndex);
      let imported = 0;
      let failed = 0;
      const errors: string[] = [];
      const now = new Date().toISOString();

      // Process in batches of 25 (DynamoDB BatchWrite limit)
      const batchSize = 25;
      for (let i = 0; i < body.items.length; i += batchSize) {
        const batch = body.items.slice(i, i + batchSize);
        const writeRequests = [];

        for (const item of batch) {
          const validationErrors = validateRequired(item, requiredFields);
          if (validationErrors.length > 0) {
            failed++;
            errors.push(`Item ${i + batch.indexOf(item)}: ${validationErrors.join(', ')}`);
            continue;
          }

          const enrichedItem = {
            ...item,
            [pkField]: item[pkField] || randomUUID(),
            pk: `${tableName.toUpperCase()}_${item[pkField] || randomUUID()}`,
            sk: 'ITEM',
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
            errors.push(`Batch ${Math.floor(i / batchSize)}: ${error}`);
          }
        }
      }

      await writeAuditLog(user, 'BULK_IMPORT', tableName, {
        totalItems: body.items.length,
        imported,
        failed
      });

      return createResponse(200, { imported, failed, errors });
    }

    // List: GET /api/{tableIndex}
    if (!subPath && method === 'GET') {
      if (!hasPermission(user, tableName, 'read')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      const limit = parseInt(queryParams.limit || '50');
      const lastKey = queryParams.lastKey ? JSON.parse(decodeURIComponent(queryParams.lastKey)) : undefined;

      const scanParams: any = {
        TableName: TABLE_NAME,
        FilterExpression: 'begins_with(pk, :pkPrefix)',
        ExpressionAttributeValues: {
          ':pkPrefix': `${tableName.toUpperCase()}_`
        },
        Limit: limit
      };

      if (lastKey) {
        scanParams.ExclusiveStartKey = lastKey;
      }

      const result = await docClient.send(new ScanCommand(scanParams));
      
      return createResponse(200, {
        items: result.Items || [],
        lastKey: result.LastEvaluatedKey ? encodeURIComponent(JSON.stringify(result.LastEvaluatedKey)) : null,
        count: result.Count || 0
      });
    }

    // Detail: GET /api/{tableIndex}/{id}
    if (subPath && method === 'GET') {
      if (!hasPermission(user, tableName, 'read')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      const result = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: `${tableName.toUpperCase()}_${subPath}`,
          sk: 'ITEM'
        }
      }));

      if (!result.Item) {
        return createResponse(404, { error: 'Item not found' });
      }

      return createResponse(200, result.Item);
    }

    // Create: POST /api/{tableIndex}
    if (!subPath && method === 'POST') {
      if (!hasPermission(user, tableName, 'create')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      const requiredFields = getRequiredFields(tableIndex);
      const validationErrors = validateRequired(body, requiredFields);
      
      if (validationErrors.length > 0) {
        return createResponse(400, { error: 'Validation failed', details: validationErrors });
      }

      const id = body[pkField] || randomUUID();
      const now = new Date().toISOString();
      
      const item = {
        ...body,
        [pkField]: id,
        pk: `${tableName.toUpperCase()}_${id}`,
        sk: 'ITEM',
        createdAt: now,
        updatedAt: now,
        createdBy: body.createdBy || user.id,
        updatedBy: user.id
      };

      await docClient.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: item
      }));

      await writeAuditLog(user, 'CREATE', tableName, { id });

      return createResponse(201, item);
    }

    // Update: PUT /api/{tableIndex}/{id}
    if (subPath && method === 'PUT') {
      if (!hasPermission(user, tableName, 'update')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      const pk = `${tableName.toUpperCase()}_${subPath}`;
      
      // Check if item exists
      const existing = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk, sk: 'ITEM' }
      }));

      if (!existing.Item) {
        return createResponse(404, { error: 'Item not found' });
      }

      const now = new Date().toISOString();
      const updatedItem = {
        ...existing.Item,
        ...body,
        [pkField]: subPath,
        pk,
        sk: 'ITEM',
        updatedAt: now,
        updatedBy: user.id
      };

      await docClient.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: updatedItem
      }));

      await writeAuditLog(user, 'UPDATE', tableName, { id: subPath });

      return createResponse(200, updatedItem);
    }

    // Delete: DELETE /api/{tableIndex}/{id}
    if (subPath && method === 'DELETE') {
      if (!hasPermission(user, tableName, 'delete')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      const pk = `${tableName.toUpperCase()}_${subPath}`;
      
      // Check if item exists
      const existing = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk, sk: 'ITEM' }
      }));

      if (!existing.Item) {
        return createResponse(404, { error: 'Item not found' });
      }

      await docClient.send(new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { pk, sk: 'ITEM' }
      }));

      await writeAuditLog(user, 'DELETE', tableName, { id: subPath });

      return createResponse(200, { message: 'Item deleted successfully' });
    }

    return createResponse(405, { error: 'Method not allowed' });

  } catch (error) {
    console.error('API Error:', error);
    return createResponse(500, { 
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};