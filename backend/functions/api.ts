import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { hasPermission, extractUserFromEvent, User } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

const TABLE_CONFIGS = {
  '0': { name: 'stores', pk: 'storeId', description: '店舗マスタ' },
  '1': { name: 'keepBottleInventory', pk: 'keepBottleId', description: 'キープボトル在庫' },
  '2': { name: 'memberVisitHistory', pk: 'visitHistoryId', description: '会員来店履歴' },
  '3': { name: 'keepBottleConsumptionHistory', pk: 'consumptionHistoryId', description: 'キープボトル消費履歴' },
  '4': { name: 'demandForecastReport', pk: 'forecastReportId', description: '需要予測レポート' },
  '5': { name: 'monthlyAggregateData', pk: 'aggregateId', description: '月次集計データ' },
  '6': { name: 'seasonalVariationAnalysis', pk: 'seasonalVariationAnalysisId', description: '季節変動分析データ' },
  '7': { name: 'replenishmentPlan', pk: 'replenishmentPlanId', description: '補充計画' },
  '8': { name: 'deliverySchedule', pk: 'deliveryScheduleId', description: '納品スケジュール' },
  '9': { name: 'deliveryRoute', pk: 'deliveryRouteId', description: '配送ルート' },
  '10': { name: 'systemUsers', pk: 'userId', description: 'システム利用者' }
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

function generateId(): string {
  return randomUUID();
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
    const method = event.httpMethod || event.requestContext?.http?.method || '';
    const pathParts = path.split('/').filter(Boolean);

    if (path === '/resources' && method === 'GET') {
      if (!hasPermission(user, 'resources', 'read')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      const resources = Object.entries(TABLE_CONFIGS).map(([index, config]) => ({
        index,
        name: config.name,
        description: config.description,
        primaryKey: config.pk
      }));

      return createResponse(200, { resources });
    }

    if (pathParts.length >= 2 && pathParts[0] === 'api') {
      const tableIndex = pathParts[1];
      
      if (!validateTableIndex(tableIndex)) {
        return createResponse(404, { error: 'Table not found' });
      }

      const tableConfig = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
      const isBulkEndpoint = pathParts[2] === 'bulk';
      const itemId = pathParts[2] && !isBulkEndpoint ? pathParts[2] : null;

      if (isBulkEndpoint && method === 'POST') {
        if (!hasPermission(user, tableConfig.name, 'bulk')) {
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

        const chunks = [];
        for (let i = 0; i < items.length; i += 25) {
          chunks.push(items.slice(i, i + 25));
        }

        for (const chunk of chunks) {
          const writeRequests = chunk.map(item => {
            const processedItem = addTimestamps({
              ...item,
              [tableConfig.pk]: item[tableConfig.pk] || generateId(),
              pk: `${tableConfig.name.toUpperCase()}_${item[tableConfig.pk] || generateId()}`,
              sk: item.sk || 'MAIN'
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
                [TABLE_NAME]: writeRequests
              }
            }));
            imported += chunk.length;
          } catch (error) {
            failed += chunk.length;
            errors.push(`Batch write failed: ${error}`);
          }
        }

        await createAuditLog(user, 'BULK_IMPORT', tableConfig.name, {
          imported,
          failed,
          totalItems: items.length
        });

        return createResponse(200, { imported, failed, errors });
      }

      switch (method) {
        case 'GET':
          if (!hasPermission(user, tableConfig.name, 'read')) {
            return createResponse(403, { error: 'Forbidden' });
          }

          if (itemId) {
            const result = await docClient.send(new GetCommand({
              TableName: TABLE_NAME,
              Key: {
                pk: `${tableConfig.name.toUpperCase()}_${itemId}`,
                sk: 'MAIN'
              }
            }));

            if (!result.Item) {
              return createResponse(404, { error: 'Item not found' });
            }

            return createResponse(200, { item: result.Item });
          } else {
            const result = await docClient.send(new ScanCommand({
              TableName: TABLE_NAME,
              FilterExpression: 'begins_with(pk, :pkPrefix)',
              ExpressionAttributeValues: {
                ':pkPrefix': `${tableConfig.name.toUpperCase()}_`
              }
            }));

            return createResponse(200, { items: result.Items || [] });
          }

        case 'POST':
          if (!hasPermission(user, tableConfig.name, 'create')) {
            return createResponse(403, { error: 'Forbidden' });
          }

          const createBody = JSON.parse(event.body || '{}');
          const newId = generateId();
          const newItem = addTimestamps({
            ...createBody,
            [tableConfig.pk]: newId,
            pk: `${tableConfig.name.toUpperCase()}_${newId}`,
            sk: 'MAIN',
            createdBy: user.id,
            updatedBy: user.id
          });

          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: newItem
          }));

          await createAuditLog(user, 'CREATE', tableConfig.name, { itemId: newId });

          return createResponse(201, { item: newItem });

        case 'PUT':
          if (!itemId) {
            return createResponse(400, { error: 'Item ID required for update' });
          }

          if (!hasPermission(user, tableConfig.name, 'update')) {
            return createResponse(403, { error: 'Forbidden' });
          }

          const updateBody = JSON.parse(event.body || '{}');
          const updatedItem = addTimestamps({
            ...updateBody,
            [tableConfig.pk]: itemId,
            pk: `${tableConfig.name.toUpperCase()}_${itemId}`,
            sk: 'MAIN',
            updatedBy: user.id
          }, true);

          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: updatedItem
          }));

          await createAuditLog(user, 'UPDATE', tableConfig.name, { itemId });

          return createResponse(200, { item: updatedItem });

        case 'DELETE':
          if (!itemId) {
            return createResponse(400, { error: 'Item ID required for delete' });
          }

          if (!hasPermission(user, tableConfig.name, 'delete')) {
            return createResponse(403, { error: 'Forbidden' });
          }

          await docClient.send(new DeleteCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: `${tableConfig.name.toUpperCase()}_${itemId}`,
              sk: 'MAIN'
            }
          }));

          await createAuditLog(user, 'DELETE', tableConfig.name, { itemId });

          return createResponse(200, { message: 'Item deleted successfully' });

        default:
          return createResponse(405, { error: 'Method not allowed' });
      }
    }

    return createResponse(404, { error: 'Endpoint not found' });

  } catch (error) {
    console.error('Error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};