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

function createErrorResponse(statusCode: number, message: string): APIResponse {
  return createResponse(statusCode, { error: message });
}

async function writeAuditLog(user: User, action: string, resource: string, details: any = {}): Promise<void> {
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

function validateTableIndex(tableIndex: string): boolean {
  return tableIndex in TABLE_CONFIGS;
}

function addTimestamps(item: any, isUpdate: boolean = false): any {
  const now = new Date().toISOString();
  const result = { ...item };
  
  if (!isUpdate) {
    result.createdAt = now;
  }
  result.updatedAt = now;
  
  return result;
}

function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
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
      return createErrorResponse(401, 'Unauthorized');
    }

    const path = event.path || event.rawPath || '';
    const method = event.httpMethod || event.requestContext?.http?.method || '';
    const pathParts = path.split('/').filter(Boolean);

    if (path === '/resources' && method === 'GET') {
      if (!hasPermission(user, 'system', 'read')) {
        return createErrorResponse(403, 'Forbidden');
      }

      const resources = Object.entries(TABLE_CONFIGS).map(([index, config]) => ({
        index,
        name: config.name,
        displayName: config.displayName,
        primaryKey: config.pk
      }));

      return createResponse(200, { resources });
    }

    if (pathParts.length >= 2 && pathParts[0] === 'api') {
      const tableIndex = pathParts[1];
      const action = pathParts[2];
      const itemId = pathParts[3];

      if (!validateTableIndex(tableIndex)) {
        return createErrorResponse(404, 'Table not found');
      }

      const tableConfig = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
      const tableName = tableConfig.name;
      const primaryKey = tableConfig.pk;

      if (action === 'bulk' && method === 'POST') {
        if (!hasPermission(user, tableName, 'bulk')) {
          return createErrorResponse(403, 'Forbidden');
        }

        let requestBody;
        try {
          requestBody = JSON.parse(event.body || '{}');
        } catch (error) {
          return createErrorResponse(400, 'Invalid JSON in request body');
        }

        if (!requestBody.items || !Array.isArray(requestBody.items)) {
          return createErrorResponse(400, 'Request body must contain items array');
        }

        const items = requestBody.items;
        let imported = 0;
        let failed = 0;
        const errors: string[] = [];

        const chunks = chunkArray(items, 25);

        for (const chunk of chunks) {
          const writeRequests = chunk.map(item => {
            const processedItem = addTimestamps({
              ...item,
              [primaryKey]: item[primaryKey] || randomUUID(),
              pk: `${tableName.toUpperCase()}#${item[primaryKey] || randomUUID()}`,
              sk: item.sk || 'ITEM'
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
            errors.push(`Batch write failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
          }
        }

        await writeAuditLog(user, 'BULK_IMPORT', tableName, {
          imported,
          failed,
          totalItems: items.length
        });

        return createResponse(200, { imported, failed, errors });
      }

      switch (method) {
        case 'GET':
          if (!hasPermission(user, tableName, 'read')) {
            return createErrorResponse(403, 'Forbidden');
          }

          if (itemId) {
            try {
              const result = await docClient.send(new GetCommand({
                TableName: TABLE_NAME,
                Key: {
                  pk: `${tableName.toUpperCase()}#${itemId}`,
                  sk: 'ITEM'
                }
              }));

              if (!result.Item) {
                return createErrorResponse(404, 'Item not found');
              }

              return createResponse(200, result.Item);
            } catch (error) {
              return createErrorResponse(500, 'Internal server error');
            }
          } else {
            try {
              const result = await docClient.send(new ScanCommand({
                TableName: TABLE_NAME,
                FilterExpression: 'begins_with(pk, :pkPrefix)',
                ExpressionAttributeValues: {
                  ':pkPrefix': `${tableName.toUpperCase()}#`
                }
              }));

              return createResponse(200, { items: result.Items || [] });
            } catch (error) {
              return createErrorResponse(500, 'Internal server error');
            }
          }

        case 'POST':
          if (!hasPermission(user, tableName, 'create')) {
            return createErrorResponse(403, 'Forbidden');
          }

          let createBody;
          try {
            createBody = JSON.parse(event.body || '{}');
          } catch (error) {
            return createErrorResponse(400, 'Invalid JSON in request body');
          }

          const newId = createBody[primaryKey] || randomUUID();
          const newItem = addTimestamps({
            ...createBody,
            [primaryKey]: newId,
            pk: `${tableName.toUpperCase()}#${newId}`,
            sk: 'ITEM'
          });

          try {
            await docClient.send(new PutCommand({
              TableName: TABLE_NAME,
              Item: newItem
            }));

            await writeAuditLog(user, 'CREATE', tableName, { itemId: newId });
            return createResponse(201, newItem);
          } catch (error) {
            return createErrorResponse(500, 'Internal server error');
          }

        case 'PUT':
          if (!itemId) {
            return createErrorResponse(400, 'Item ID is required for PUT requests');
          }

          if (!hasPermission(user, tableName, 'update')) {
            return createErrorResponse(403, 'Forbidden');
          }

          let updateBody;
          try {
            updateBody = JSON.parse(event.body || '{}');
          } catch (error) {
            return createErrorResponse(400, 'Invalid JSON in request body');
          }

          const updatedItem = addTimestamps({
            ...updateBody,
            [primaryKey]: itemId,
            pk: `${tableName.toUpperCase()}#${itemId}`,
            sk: 'ITEM'
          }, true);

          try {
            await docClient.send(new PutCommand({
              TableName: TABLE_NAME,
              Item: updatedItem
            }));

            await writeAuditLog(user, 'UPDATE', tableName, { itemId });
            return createResponse(200, updatedItem);
          } catch (error) {
            return createErrorResponse(500, 'Internal server error');
          }

        case 'DELETE':
          if (!itemId) {
            return createErrorResponse(400, 'Item ID is required for DELETE requests');
          }

          if (!hasPermission(user, tableName, 'delete')) {
            return createErrorResponse(403, 'Forbidden');
          }

          try {
            await docClient.send(new DeleteCommand({
              TableName: TABLE_NAME,
              Key: {
                pk: `${tableName.toUpperCase()}#${itemId}`,
                sk: 'ITEM'
              }
            }));

            await writeAuditLog(user, 'DELETE', tableName, { itemId });
            return createResponse(200, { message: 'Item deleted successfully' });
          } catch (error) {
            return createErrorResponse(500, 'Internal server error');
          }

        default:
          return createErrorResponse(405, 'Method not allowed');
      }
    }

    return createErrorResponse(404, 'Not found');
  } catch (error) {
    console.error('Unhandled error:', error);
    return createErrorResponse(500, 'Internal server error');
  }
};