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

function createResponse(statusCode: number, body: any) {
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
  const auditLog = {
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
    Item: auditLog
  }));
}

function validateTableIndex(tableIndex: string): boolean {
  return tableIndex in TABLE_CONFIGS;
}

function addTimestamps(item: any, isUpdate = false): any {
  const now = new Date().toISOString();
  const result = { ...item };
  
  if (!isUpdate) {
    result.createdAt = now;
  }
  result.updatedAt = now;
  
  return result;
}

export const handler = async (event: any) => {
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
    
    let body = {};
    if (event.body) {
      try {
        body = JSON.parse(event.body);
      } catch {
        return createResponse(400, { error: 'Invalid JSON body' });
      }
    }

    // GET /resources - システムリソース一覧
    if (path === '/resources' && method === 'GET') {
      if (!hasPermission(user, 'system', 'read')) {
        return createResponse(403, { error: 'Forbidden' });
      }
      
      const resources = Object.entries(TABLE_CONFIGS).map(([index, config]) => ({
        tableIndex: index,
        name: config.name,
        displayName: config.displayName,
        primaryKey: config.pk
      }));
      
      return createResponse(200, { resources });
    }

    // テーブル操作のパスパターン解析
    const tablePathMatch = path.match(/^\/api\/(\d+)(?:\/(\w+))?(?:\/(bulk|[a-f0-9-]+))?$/);
    if (!tablePathMatch) {
      return createResponse(404, { error: 'Not found' });
    }

    const [, tableIndex, action, idOrBulk] = tablePathMatch;
    
    if (!validateTableIndex(tableIndex)) {
      return createResponse(400, { error: 'Invalid table index' });
    }

    const tableConfig = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    const pkField = tableConfig.pk;

    // 一括インポート処理
    if (method === 'POST' && idOrBulk === 'bulk') {
      if (!hasPermission(user, tableConfig.name, 'bulk')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      const { items } = body as { items: Record<string, unknown>[] };
      if (!Array.isArray(items)) {
        return createResponse(400, { error: 'Items must be an array' });
      }

      let imported = 0;
      let failed = 0;
      const errors: string[] = [];

      // 25件ずつに分割してバッチ処理
      for (let i = 0; i < items.length; i += 25) {
        const batch = items.slice(i, i + 25);
        const putRequests = batch.map(item => {
          const processedItem = addTimestamps({
            ...item,
            pk: tableConfig.name,
            sk: item[pkField] || randomUUID(),
            [pkField]: item[pkField] || randomUUID()
          });
          
          return {
            PutRequest: {
              Item: processedItem
            }
          };
        });

        try {
          await docClient.send(new BatchWriteCommand({
            RequestItems: {
              [TABLE_NAME]: putRequests
            }
          }));
          imported += batch.length;
        } catch (error) {
          failed += batch.length;
          errors.push(`Batch ${Math.floor(i/25) + 1}: ${error}`);
        }
      }

      await writeAuditLog(user, 'BULK_IMPORT', tableConfig.displayName, {
        tableIndex,
        imported,
        failed,
        totalItems: items.length
      });

      return createResponse(200, { imported, failed, errors });
    }

    // 一覧取得
    if (method === 'GET' && !idOrBulk) {
      if (!hasPermission(user, tableConfig.name, 'read')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      const limit = queryParams.limit ? parseInt(queryParams.limit) : 100;
      const lastEvaluatedKey = queryParams.lastEvaluatedKey ? 
        JSON.parse(decodeURIComponent(queryParams.lastEvaluatedKey)) : undefined;

      const result = await docClient.send(new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'pk = :pk',
        ExpressionAttributeValues: {
          ':pk': tableConfig.name
        },
        Limit: limit,
        ExclusiveStartKey: lastEvaluatedKey
      }));

      return createResponse(200, {
        items: result.Items || [],
        lastEvaluatedKey: result.LastEvaluatedKey,
        count: result.Count
      });
    }

    // 詳細取得
    if (method === 'GET' && idOrBulk) {
      if (!hasPermission(user, tableConfig.name, 'read')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      const result = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: tableConfig.name,
          sk: idOrBulk
        }
      }));

      if (!result.Item) {
        return createResponse(404, { error: 'Item not found' });
      }

      return createResponse(200, result.Item);
    }

    // 新規作成
    if (method === 'POST' && !idOrBulk) {
      if (!hasPermission(user, tableConfig.name, 'create')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      const id = randomUUID();
      const item = addTimestamps({
        ...body,
        pk: tableConfig.name,
        sk: id,
        [pkField]: id,
        createdBy: user.id,
        updatedBy: user.id
      });

      await docClient.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: item
      }));

      await writeAuditLog(user, 'CREATE', tableConfig.displayName, { id, item });

      return createResponse(201, item);
    }

    // 更新
    if (method === 'PUT' && idOrBulk) {
      if (!hasPermission(user, tableConfig.name, 'update')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      // 既存アイテムの確認
      const existing = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: tableConfig.name,
          sk: idOrBulk
        }
      }));

      if (!existing.Item) {
        return createResponse(404, { error: 'Item not found' });
      }

      const updatedItem = addTimestamps({
        ...existing.Item,
        ...body,
        pk: tableConfig.name,
        sk: idOrBulk,
        [pkField]: idOrBulk,
        updatedBy: user.id
      }, true);

      await docClient.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: updatedItem
      }));

      await writeAuditLog(user, 'UPDATE', tableConfig.displayName, { id: idOrBulk, changes: body });

      return createResponse(200, updatedItem);
    }

    // 削除
    if (method === 'DELETE' && idOrBulk) {
      if (!hasPermission(user, tableConfig.name, 'delete')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      // 既存アイテムの確認
      const existing = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: tableConfig.name,
          sk: idOrBulk
        }
      }));

      if (!existing.Item) {
        return createResponse(404, { error: 'Item not found' });
      }

      await docClient.send(new DeleteCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: tableConfig.name,
          sk: idOrBulk
        }
      }));

      await writeAuditLog(user, 'DELETE', tableConfig.displayName, { id: idOrBulk, deletedItem: existing.Item });

      return createResponse(200, { message: 'Item deleted successfully' });
    }

    return createResponse(405, { error: 'Method not allowed' });

  } catch (error) {
    console.error('Error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};