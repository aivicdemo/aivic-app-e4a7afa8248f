import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { hasPermission, extractUserFromEvent, User } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

const tableConfigs = [
  { index: 0, name: 'stores', pk: 'STORE', description: '店舗マスタ' },
  { index: 1, name: 'keep_bottles', pk: 'KEEP_BOTTLE', description: 'キープボトル在庫' },
  { index: 2, name: 'visit_history', pk: 'VISIT_HISTORY', description: '会員来店履歴' },
  { index: 3, name: 'consumption_history', pk: 'CONSUMPTION_HISTORY', description: 'キープボトル消費履歴' },
  { index: 4, name: 'demand_forecast', pk: 'DEMAND_FORECAST', description: '需要予測レポート' },
  { index: 5, name: 'monthly_summary', pk: 'MONTHLY_SUMMARY', description: '月次集計データ' },
  { index: 6, name: 'seasonal_analysis', pk: 'SEASONAL_ANALYSIS', description: '季節変動分析データ' },
  { index: 7, name: 'replenishment_plan', pk: 'REPLENISHMENT_PLAN', description: '補充計画' },
  { index: 8, name: 'delivery_schedule', pk: 'DELIVERY_SCHEDULE', description: '納品スケジュール' },
  { index: 9, name: 'delivery_route', pk: 'DELIVERY_ROUTE', description: '配送ルート' },
  { index: 10, name: 'system_users', pk: 'SYSTEM_USER', description: 'システム利用者' }
];

interface APIGatewayEvent {
  httpMethod: string;
  pathParameters?: { [key: string]: string };
  queryStringParameters?: { [key: string]: string };
  body?: string;
  headers?: { [key: string]: string };
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
    timestamp: new Date().toISOString(),
    createdAt: new Date().toISOString()
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

function getRequiredFieldsByTableIndex(tableIndex: number): string[] {
  const fieldMaps = {
    0: ['店舗コード', '店舗名', '店舗区分', '都道府県', '市区町村', '取引開始日', '取引状態', '有効フラグ'],
    1: ['店舗ID', '顧客名', '商品名', 'カテゴリ', '容量ml', '残量ml', '残量パーセント', 'キープ開始日', 'ステータス'],
    2: ['会員ID', '店舗ID', '来店日時', 'キープボトル利用フラグ', '新規ボトル注文フラグ'],
    3: ['店舗ID', 'キープボトルID', '会員ID', '消費日時', '消費量', '残量', '完飲フラグ'],
    4: ['店舗ID', '商品カテゴリ', '予測対象期間開始日', '予測対象期間終了日', '予測需要量', '予測信頼度', '季節要因フラグ', 'イベント要因フラグ', '推奨仕入れ量'],
    5: ['店舗ID', '集計年月', '商品カテゴリ', '新規キープボトル数', '消費完了ボトル数', '総消費量', '来店客数', 'アクティブ会員数', '平均消費量'],
    6: ['分析対象年', '分析対象月', '酒類カテゴリ', '地域コード', '基準消費量', '実績消費量', '季節変動指数', 'イベント影響フラグ'],
    7: ['店舗ID', '商品コード', '商品名', '計画対象期間開始日', '計画対象期間終了日', '現在在庫数', '予測需要数', '安全在庫数', '計画補充数', '補充予定日', '計画ステータス', '優先度'],
    8: ['店舗ID', '商品コード', '商品名', '予定納品日', '予定数量', '納品ステータス'],
    9: ['ルート名', '担当ドライバーID', '配送車両ID', '開始地点', '終了地点', '予想所要時間', '総距離', '最大積載容量', '配送曜日', '開始時刻', '有効フラグ'],
    10: ['ログインID', 'パスワードハッシュ', '利用者名', 'メールアドレス', '権限レベル', '所属組織', 'アカウント状態']
  };
  return fieldMaps[tableIndex as keyof typeof fieldMaps] || [];
}

async function handleBulkImport(event: APIGatewayEvent, user: User, tableIndex: number): Promise<APIGatewayResponse> {
  if (!hasPermission(user, 'bulk', 'bulk')) {
    return createResponse(403, { error: 'Insufficient permissions for bulk import' });
  }

  const tableConfig = tableConfigs.find(t => t.index === tableIndex);
  if (!tableConfig) {
    return createResponse(404, { error: 'Table not found' });
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
  const requiredFields = getRequiredFieldsByTableIndex(tableIndex);
  let imported = 0;
  let failed = 0;
  const errors: string[] = [];

  // Process items in batches of 25 (DynamoDB BatchWrite limit)
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

      const now = new Date().toISOString();
      const processedItem = {
        ...item,
        pk: tableConfig.pk,
        sk: item.id || randomUUID(),
        id: item.id || randomUUID(),
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

  await createAuditLog(user, 'BULK_IMPORT', tableConfig.name, {
    tableIndex,
    totalItems: items.length,
    imported,
    failed
  });

  return createResponse(200, {
    imported,
    failed,
    errors
  });
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

    // Handle /resources endpoint
    if (path === 'resources' && event.httpMethod === 'GET') {
      if (!hasPermission(user, 'resources', 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      return createResponse(200, {
        tables: tableConfigs.map(config => ({
          index: config.index,
          name: config.name,
          description: config.description
        }))
      });
    }

    // Handle table-specific endpoints
    if (pathParts.length >= 2) {
      const tableIndex = parseInt(pathParts[0]);
      const action = pathParts[1];
      const itemId = pathParts[2];

      const tableConfig = tableConfigs.find(t => t.index === tableIndex);
      if (!tableConfig) {
        return createResponse(404, { error: 'Table not found' });
      }

      // Handle bulk import
      if (action === 'bulk' && event.httpMethod === 'POST') {
        return await handleBulkImport(event, user, tableIndex);
      }

      // Handle CRUD operations
      switch (event.httpMethod) {
        case 'GET':
          if (!hasPermission(user, tableConfig.name, 'read')) {
            return createResponse(403, { error: 'Insufficient permissions' });
          }

          if (itemId) {
            // Get single item
            const result = await docClient.send(new GetCommand({
              TableName: TABLE_NAME,
              Key: { pk: tableConfig.pk, sk: itemId }
            }));

            if (!result.Item) {
              return createResponse(404, { error: 'Item not found' });
            }

            return createResponse(200, result.Item);
          } else {
            // List items
            const limit = event.queryStringParameters?.limit ? parseInt(event.queryStringParameters.limit) : 50;
            const lastKey = event.queryStringParameters?.lastKey;

            const scanParams: any = {
              TableName: TABLE_NAME,
              FilterExpression: 'pk = :pk',
              ExpressionAttributeValues: { ':pk': tableConfig.pk },
              Limit: Math.min(limit, 100)
            };

            if (lastKey) {
              try {
                scanParams.ExclusiveStartKey = JSON.parse(Buffer.from(lastKey, 'base64').toString());
              } catch (error) {
                return createResponse(400, { error: 'Invalid lastKey parameter' });
              }
            }

            const result = await docClient.send(new ScanCommand(scanParams));

            return createResponse(200, {
              items: result.Items || [],
              lastKey: result.LastEvaluatedKey ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64') : null,
              count: result.Count || 0
            });
          }

        case 'POST':
          if (!hasPermission(user, tableConfig.name, 'create')) {
            return createResponse(403, { error: 'Insufficient permissions' });
          }

          let createBody;
          try {
            createBody = JSON.parse(event.body || '{}');
          } catch (error) {
            return createResponse(400, { error: 'Invalid JSON in request body' });
          }

          const requiredFields = getRequiredFieldsByTableIndex(tableIndex);
          const validationErrors = validateRequiredFields(createBody, requiredFields);
          if (validationErrors.length > 0) {
            return createResponse(400, { error: 'Validation failed', details: validationErrors });
          }

          const newId = randomUUID();
          const now = new Date().toISOString();
          const newItem = {
            ...createBody,
            pk: tableConfig.pk,
            sk: newId,
            id: newId,
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
            return createResponse(403, { error: 'Insufficient permissions' });
          }

          let updateBody;
          try {
            updateBody = JSON.parse(event.body || '{}');
          } catch (error) {
            return createResponse(400, { error: 'Invalid JSON in request body' });
          }

          // Check if item exists
          const existingItem = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: { pk: tableConfig.pk, sk: itemId }
          }));

          if (!existingItem.Item) {
            return createResponse(404, { error: 'Item not found' });
          }

          const updatedItem = {
            ...existingItem.Item,
            ...updateBody,
            pk: tableConfig.pk,
            sk: itemId,
            id: itemId,
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
            return createResponse(400, { error: 'Item ID required for deletion' });
          }

          if (!hasPermission(user, tableConfig.name, 'delete')) {
            return createResponse(403, { error: 'Insufficient permissions' });
          }

          // Check if item exists
          const itemToDelete = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: { pk: tableConfig.pk, sk: itemId }
          }));

          if (!itemToDelete.Item) {
            return createResponse(404, { error: 'Item not found' });
          }

          await docClient.send(new DeleteCommand({
            TableName: TABLE_NAME,
            Key: { pk: tableConfig.pk, sk: itemId }
          }));

          await createAuditLog(user, 'DELETE', tableConfig.name, { itemId });

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