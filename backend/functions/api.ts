import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { hasPermission, extractUserFromEvent, User } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

const TABLE_CONFIGS = {
  '0': { name: 'stores', pk: 'storeId', displayName: '店舗マスタ' },
  '1': { name: 'keepBottleInventory', pk: 'keepBottleId', displayName: 'キープボトル在庫' },
  '2': { name: 'memberVisitHistory', pk: 'visitHistoryId', displayName: '会員来店履歴' },
  '3': { name: 'keepBottleConsumptionHistory', pk: 'consumptionHistoryId', displayName: 'キープボトル消費履歴' },
  '4': { name: 'demandForecastReport', pk: 'forecastReportId', displayName: '需要予測レポート' },
  '5': { name: 'monthlyAggregateData', pk: 'aggregateId', displayName: '月次集計データ' },
  '6': { name: 'seasonalVariationAnalysis', pk: 'seasonalAnalysisId', displayName: '季節変動分析データ' },
  '7': { name: 'replenishmentPlan', pk: 'replenishmentPlanId', displayName: '補充計画' },
  '8': { name: 'deliverySchedule', pk: 'deliveryScheduleId', displayName: '納品スケジュール' },
  '9': { name: 'deliveryRoute', pk: 'deliveryRouteId', displayName: '配送ルート' },
  '10': { name: 'systemUsers', pk: 'userId', displayName: 'システム利用者' }
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
  
  try {
    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: auditLog
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
    '0': ['storeCode', 'storeName', 'storeCategory', 'prefecture', 'city', 'transactionStartDate', 'transactionStatus', 'validFlag', 'createdBy', 'updatedBy'],
    '1': ['storeId', 'customerName', 'productName', 'category', 'capacityMl', 'remainingMl', 'remainingPercent', 'keepStartDate', 'status', 'createdBy'],
    '2': ['memberId', 'storeId', 'visitDateTime', 'keepBottleUsedFlag', 'newBottleOrderFlag', 'createdBy'],
    '3': ['storeId', 'keepBottleId', 'memberId', 'consumptionDateTime', 'consumptionAmount', 'remainingAmount', 'completedFlag', 'createdBy'],
    '4': ['storeId', 'productCategory', 'forecastPeriodStart', 'forecastPeriodEnd', 'forecastDemand', 'confidenceLevel', 'seasonalFactorFlag', 'eventFactorFlag', 'recommendedPurchaseAmount', 'createdBy'],
    '5': ['storeId', 'aggregateYearMonth', 'productCategory', 'newKeepBottles', 'completedBottles', 'totalConsumption', 'visitCount', 'activeMemberCount', 'averageConsumption', 'createdBy'],
    '6': ['analysisYear', 'analysisMonth', 'alcoholCategory', 'regionCode', 'baseConsumption', 'actualConsumption', 'seasonalIndex', 'eventInfluenceFlag', 'createdBy'],
    '7': ['storeId', 'productCode', 'productName', 'planPeriodStart', 'planPeriodEnd', 'currentStock', 'forecastDemand', 'safetyStock', 'plannedReplenishment', 'scheduledDate', 'planStatus', 'priority', 'createdBy'],
    '8': ['storeId', 'productCode', 'productName', 'scheduledDeliveryDate', 'scheduledQuantity', 'deliveryStatus', 'createdBy'],
    '9': ['routeName', 'driverUserId', 'vehicleId', 'startLocation', 'endLocation', 'estimatedDuration', 'totalDistance', 'maxCapacity', 'deliveryDays', 'startTime', 'validFlag', 'createdBy'],
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
    
    // GET /resources - システム情報取得
    if (path === '/resources' && method === 'GET') {
      if (!hasPermission(user, 'system', 'read')) {
        return createResponse(403, { error: 'Forbidden' });
      }
      
      return createResponse(200, {
        tables: Object.entries(TABLE_CONFIGS).map(([index, config]) => ({
          index,
          name: config.name,
          displayName: config.displayName,
          primaryKey: config.pk
        })),
        userInfo: {
          id: user.id,
          role: user.role,
          permissions: {
            canCreate: hasPermission(user, 'data', 'create'),
            canUpdate: hasPermission(user, 'data', 'update'),
            canDelete: hasPermission(user, 'data', 'delete'),
            canBulkImport: hasPermission(user, 'data', 'bulk')
          }
        }
      });
    }

    // テーブル操作のルーティング
    const tableMatch = path.match(/^\/api\/(\d+)(?:\/(\w+))?(?:\/(\w+))?$/);
    if (!tableMatch) {
      return createResponse(404, { error: 'Not Found' });
    }

    const [, tableIndex, operation, itemId] = tableMatch;
    const tableConfig = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    
    if (!tableConfig) {
      return createResponse(404, { error: 'Table not found' });
    }

    const resourceName = tableConfig.name;
    const primaryKey = tableConfig.pk;

    // 一括インポート処理
    if (operation === 'bulk' && method === 'POST') {
      if (!hasPermission(user, resourceName, 'bulk')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      let requestBody;
      try {
        requestBody = JSON.parse(event.body || '{}');
      } catch {
        return createResponse(400, { error: 'Invalid JSON' });
      }

      if (!requestBody.items || !Array.isArray(requestBody.items)) {
        return createResponse(400, { error: 'items array is required' });
      }

      const items = requestBody.items;
      const requiredFields = getRequiredFields(tableIndex);
      let imported = 0;
      let failed = 0;
      const errors: string[] = [];
      const now = new Date().toISOString();

      // 25件ずつに分割してバッチ処理
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

          const enhancedItem = {
            ...item,
            [primaryKey]: item[primaryKey] || randomUUID(),
            pk: `${resourceName.toUpperCase()}#${item[primaryKey] || randomUUID()}`,
            sk: item[primaryKey] || randomUUID(),
            createdAt: now,
            updatedAt: now
          };

          writeRequests.push({
            PutRequest: {
              Item: enhancedItem
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

      await writeAuditLog(user, 'BULK_IMPORT', resourceName, { 
        imported, 
        failed, 
        totalItems: items.length 
      });

      return createResponse(200, { imported, failed, errors });
    }

    // 一覧取得
    if (method === 'GET' && !itemId) {
      if (!hasPermission(user, resourceName, 'read')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      try {
        const result = await docClient.send(new ScanCommand({
          TableName: TABLE_NAME,
          FilterExpression: 'begins_with(pk, :pkPrefix)',
          ExpressionAttributeValues: {
            ':pkPrefix': `${resourceName.toUpperCase()}#`
          }
        }));

        return createResponse(200, {
          items: result.Items || [],
          count: result.Count || 0
        });
      } catch (error) {
        console.error('Scan error:', error);
        return createResponse(500, { error: 'Internal server error' });
      }
    }

    // 詳細取得
    if (method === 'GET' && itemId) {
      if (!hasPermission(user, resourceName, 'read')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      try {
        const result = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: `${resourceName.toUpperCase()}#${itemId}`,
            sk: itemId
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

    // 新規作成
    if (method === 'POST' && !itemId) {
      if (!hasPermission(user, resourceName, 'create')) {
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

      const id = requestBody[primaryKey] || randomUUID();
      const now = new Date().toISOString();
      
      const item = {
        ...requestBody,
        [primaryKey]: id,
        pk: `${resourceName.toUpperCase()}#${id}`,
        sk: id,
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

        await writeAuditLog(user, 'CREATE', resourceName, { itemId: id });
        return createResponse(201, item);
      } catch (error) {
        console.error('Put error:', error);
        return createResponse(500, { error: 'Internal server error' });
      }
    }

    // 更新
    if (method === 'PUT' && itemId) {
      if (!hasPermission(user, resourceName, 'update')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      let requestBody;
      try {
        requestBody = JSON.parse(event.body || '{}');
      } catch {
        return createResponse(400, { error: 'Invalid JSON' });
      }

      // 既存アイテムの存在確認
      try {
        const existing = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: `${resourceName.toUpperCase()}#${itemId}`,
            sk: itemId
          }
        }));

        if (!existing.Item) {
          return createResponse(404, { error: 'Item not found' });
        }

        const updatedItem = {
          ...existing.Item,
          ...requestBody,
          [primaryKey]: itemId,
          pk: `${resourceName.toUpperCase()}#${itemId}`,
          sk: itemId,
          updatedAt: new Date().toISOString(),
          updatedBy: user.id
        };

        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: updatedItem
        }));

        await writeAuditLog(user, 'UPDATE', resourceName, { itemId });
        return createResponse(200, updatedItem);
      } catch (error) {
        console.error('Update error:', error);
        return createResponse(500, { error: 'Internal server error' });
      }
    }

    // 削除
    if (method === 'DELETE' && itemId) {
      if (!hasPermission(user, resourceName, 'delete')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      try {
        const existing = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: `${resourceName.toUpperCase()}#${itemId}`,
            sk: itemId
          }
        }));

        if (!existing.Item) {
          return createResponse(404, { error: 'Item not found' });
        }

        await docClient.send(new DeleteCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: `${resourceName.toUpperCase()}#${itemId}`,
            sk: itemId
          }
        }));

        await writeAuditLog(user, 'DELETE', resourceName, { itemId });
        return createResponse(200, { message: 'Item deleted successfully' });
      } catch (error) {
        console.error('Delete error:', error);
        return createResponse(500, { error: 'Internal server error' });
      }
    }

    return createResponse(405, { error: 'Method not allowed' });
  } catch (error) {
    console.error('Handler error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};