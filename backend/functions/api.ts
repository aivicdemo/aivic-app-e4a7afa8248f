import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { hasPermission, extractUserFromEvent, User } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

const TABLE_CONFIGS = {
  '0': { name: 'stores', pk: 'storeId', sortKey: null },
  '1': { name: 'keep_bottles', pk: 'keepBottleId', sortKey: null },
  '2': { name: 'visit_history', pk: 'visitHistoryId', sortKey: null },
  '3': { name: 'consumption_history', pk: 'consumptionHistoryId', sortKey: null },
  '4': { name: 'demand_forecast', pk: 'forecastReportId', sortKey: null },
  '5': { name: 'monthly_summary', pk: 'summaryId', sortKey: null },
  '6': { name: 'seasonal_analysis', pk: 'seasonalAnalysisId', sortKey: null },
  '7': { name: 'replenishment_plan', pk: 'replenishmentPlanId', sortKey: null },
  '8': { name: 'delivery_schedule', pk: 'deliveryScheduleId', sortKey: null },
  '9': { name: 'delivery_route', pk: 'deliveryRouteId', sortKey: null },
  '10': { name: 'system_users', pk: 'userId', sortKey: null }
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

function validateRequired(item: any, requiredFields: string[]): string[] {
  const errors: string[] = [];
  for (const field of requiredFields) {
    if (!item[field]) {
      errors.push(`${field} is required`);
    }
  }
  return errors;
}

function addTimestamps(item: any, isUpdate = false) {
  const now = new Date().toISOString();
  if (!isUpdate) {
    item.createdAt = now;
  }
  item.updatedAt = now;
  return item;
}

export const handler = async (event: any): Promise<APIResponse> => {
  try {
    const method = event.httpMethod;
    const path = event.path;
    const pathParams = event.pathParameters || {};
    
    if (method === 'OPTIONS') {
      return createResponse(200, {});
    }

    let user: User;
    try {
      user = extractUserFromEvent(event);
    } catch (error) {
      return createResponse(401, { error: 'Unauthorized' });
    }

    // GET /resources - リソース一覧取得
    if (method === 'GET' && path === '/resources') {
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

    // テーブル操作のルーティング
    const tableMatch = path.match(/^\/api\/(\d+)(?:\/(\w+))?(?:\/(\w+))?$/);
    if (!tableMatch) {
      return createResponse(404, { error: 'Not found' });
    }

    const [, tableIndex, operation, itemId] = tableMatch;
    const tableConfig = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    
    if (!tableConfig) {
      return createResponse(404, { error: 'Table not found' });
    }

    const resource = tableConfig.name;

    // 一括インポート
    if (method === 'POST' && operation === 'bulk') {
      if (!hasPermission(user, resource, 'bulk')) {
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

      // 25件ずつに分割してバッチ処理
      for (let i = 0; i < items.length; i += 25) {
        const batch = items.slice(i, i + 25);
        const writeRequests = batch.map(item => {
          const processedItem = {
            ...item,
            [tableConfig.pk]: item[tableConfig.pk] || randomUUID(),
            ...addTimestamps({})
          };
          
          return {
            PutRequest: {
              Item: {
                pk: processedItem[tableConfig.pk],
                sk: tableConfig.sortKey ? processedItem[tableConfig.sortKey] : 'ITEM',
                ...processedItem
              }
            }
          };
        });

        try {
          await docClient.send(new BatchWriteCommand({
            RequestItems: {
              [TABLE_NAME]: writeRequests
            }
          }));
          imported += batch.length;
        } catch (error) {
          failed += batch.length;
          errors.push(`Batch ${Math.floor(i/25) + 1}: ${error}`);
        }
      }

      await createAuditLog(user, 'BULK_IMPORT', resource, { imported, failed, total: items.length });
      
      return createResponse(200, { imported, failed, errors });
    }

    // 一覧取得
    if (method === 'GET' && !operation) {
      if (!hasPermission(user, resource, 'read')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      const result = await docClient.send(new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'begins_with(pk, :prefix)',
        ExpressionAttributeValues: {
          ':prefix': tableConfig.name
        }
      }));

      return createResponse(200, { items: result.Items || [] });
    }

    // 詳細取得
    if (method === 'GET' && operation && !itemId) {
      if (!hasPermission(user, resource, 'read')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      const result = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: operation,
          sk: 'ITEM'
        }
      }));

      if (!result.Item) {
        return createResponse(404, { error: 'Item not found' });
      }

      return createResponse(200, { item: result.Item });
    }

    // 作成
    if (method === 'POST' && !operation) {
      if (!hasPermission(user, resource, 'create')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      const body = JSON.parse(event.body || '{}');
      const id = body[tableConfig.pk] || randomUUID();
      
      const item = {
        pk: id,
        sk: 'ITEM',
        [tableConfig.pk]: id,
        ...body,
        ...addTimestamps({})
      };

      await docClient.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: item
      }));

      await createAuditLog(user, 'CREATE', resource, { id });
      
      return createResponse(201, { item });
    }

    // 更新
    if (method === 'PUT' && operation) {
      if (!hasPermission(user, resource, 'update')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      const body = JSON.parse(event.body || '{}');
      
      // 既存アイテムの確認
      const existing = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: operation,
          sk: 'ITEM'
        }
      }));

      if (!existing.Item) {
        return createResponse(404, { error: 'Item not found' });
      }

      const updatedItem = {
        ...existing.Item,
        ...body,
        [tableConfig.pk]: operation,
        ...addTimestamps({}, true)
      };

      await docClient.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: updatedItem
      }));

      await createAuditLog(user, 'UPDATE', resource, { id: operation });
      
      return createResponse(200, { item: updatedItem });
    }

    // 削除
    if (method === 'DELETE' && operation) {
      if (!hasPermission(user, resource, 'delete')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      await docClient.send(new DeleteCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: operation,
          sk: 'ITEM'
        }
      }));

      await createAuditLog(user, 'DELETE', resource, { id: operation });
      
      return createResponse(200, { message: 'Item deleted successfully' });
    }

    return createResponse(404, { error: 'Not found' });
    
  } catch (error) {
    console.error('Error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};