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

function validateRequiredFields(item: any, requiredFields: string[]): string[] {
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
    '0': ['storeCode', 'storeName', 'storeCategory', 'prefecture', 'city', 'transactionStartDate', 'transactionStatus', 'activeFlag', 'createdBy', 'updatedBy'],
    '1': ['storeId', 'customerName', 'productName', 'category', 'capacityMl', 'remainingMl', 'remainingPercent', 'keepStartDate', 'status', 'createdBy'],
    '2': ['memberId', 'storeId', 'visitDateTime', 'keepBottleUsedFlag', 'newBottleOrderFlag', 'createdBy'],
    '3': ['storeId', 'keepBottleId', 'memberId', 'consumptionDateTime', 'consumptionAmount', 'remainingAmount', 'completedFlag', 'createdBy'],
    '4': ['storeId', 'productCategory', 'forecastPeriodStart', 'forecastPeriodEnd', 'forecastDemand', 'confidenceLevel', 'seasonalFlag', 'eventFlag', 'recommendedPurchase', 'createdBy'],
    '5': ['storeId', 'summaryMonth', 'productCategory', 'newKeepBottles', 'completedBottles', 'totalConsumption', 'visitCount', 'activeMemberCount', 'averageConsumption', 'createdBy'],
    '6': ['analysisYear', 'analysisMonth', 'alcoholCategory', 'regionCode', 'baseConsumption', 'actualConsumption', 'seasonalIndex', 'eventInfluenceFlag', 'createdBy'],
    '7': ['storeId', 'productCode', 'productName', 'planPeriodStart', 'planPeriodEnd', 'currentStock', 'forecastDemand', 'safetyStock', 'plannedReplenishment', 'scheduledDate', 'planStatus', 'priority', 'createdBy'],
    '8': ['storeId', 'productCode', 'productName', 'scheduledDeliveryDate', 'scheduledQuantity', 'deliveryStatus', 'createdBy'],
    '9': ['routeName', 'driverUserId', 'vehicleId', 'startLocation', 'endLocation', 'estimatedDuration', 'totalDistance', 'maxCapacity', 'deliveryDays', 'startTime', 'activeFlag', 'createdBy'],
    '10': ['loginId', 'passwordHash', 'userName', 'email', 'permissionLevel', 'organization', 'accountStatus', 'createdBy']
  };
  return fieldMap[tableIndex] || [];
}

function addTimestamps(item: any, isUpdate: boolean = false): any {
  const now = new Date().toISOString();
  if (!isUpdate) {
    item.createdAt = now;
  }
  item.updatedAt = now;
  return item;
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

    if (pathParts.length === 1 && pathParts[0] === 'resources' && method === 'GET') {
      if (!hasPermission(user, 'resources', 'read')) {
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
      const tableConfig = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
      
      if (!tableConfig) {
        return createErrorResponse(404, 'Table not found');
      }

      const isBulkOperation = pathParts[2] === 'bulk';
      const resourceId = pathParts[2] && !isBulkOperation ? pathParts[2] : null;

      if (isBulkOperation && method === 'POST') {
        if (!hasPermission(user, tableConfig.name, 'bulk')) {
          return createErrorResponse(403, 'Forbidden');
        }

        const body = JSON.parse(event.body || '{}');
        const items = body.items || [];
        
        if (!Array.isArray(items)) {
          return createErrorResponse(400, 'Items must be an array');
        }

        let imported = 0;
        let failed = 0;
        const errors: string[] = [];
        const requiredFields = getRequiredFields(tableIndex);

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

            const processedItem = {
              ...item,
              pk: tableConfig.name,
              sk: item[tableConfig.pk] || randomUUID(),
              [tableConfig.pk]: item[tableConfig.pk] || randomUUID()
            };
            addTimestamps(processedItem);

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

        await writeAuditLog(user, 'BULK_IMPORT', tableConfig.name, { imported, failed, total: items.length });

        return createResponse(200, { imported, failed, errors });
      }

      switch (method) {
        case 'GET':
          if (!hasPermission(user, tableConfig.name, 'read')) {
            return createErrorResponse(403, 'Forbidden');
          }

          if (resourceId) {
            try {
              const result = await docClient.send(new GetCommand({
                TableName: TABLE_NAME,
                Key: {
                  pk: tableConfig.name,
                  sk: resourceId
                }
              }));
              
              if (!result.Item) {
                return createErrorResponse(404, 'Resource not found');
              }
              
              return createResponse(200, result.Item);
            } catch (error) {
              return createErrorResponse(500, 'Internal server error');
            }
          } else {
            try {
              const result = await docClient.send(new ScanCommand({
                TableName: TABLE_NAME,
                FilterExpression: 'pk = :pk',
                ExpressionAttributeValues: {
                  ':pk': tableConfig.name
                }
              }));
              
              return createResponse(200, { items: result.Items || [] });
            } catch (error) {
              return createErrorResponse(500, 'Internal server error');
            }
          }

        case 'POST':
          if (!hasPermission(user, tableConfig.name, 'create')) {
            return createErrorResponse(403, 'Forbidden');
          }

          try {
            const body = JSON.parse(event.body || '{}');
            const requiredFields = getRequiredFields(tableIndex);
            const validationErrors = validateRequiredFields(body, requiredFields);
            
            if (validationErrors.length > 0) {
              return createErrorResponse(400, `Validation failed: ${validationErrors.join(', ')}`);
            }

            const id = randomUUID();
            const item = {
              ...body,
              pk: tableConfig.name,
              sk: id,
              [tableConfig.pk]: id
            };
            addTimestamps(item);

            await docClient.send(new PutCommand({
              TableName: TABLE_NAME,
              Item: item
            }));

            await writeAuditLog(user, 'CREATE', tableConfig.name, { id });
            return createResponse(201, item);
          } catch (error) {
            return createErrorResponse(500, 'Internal server error');
          }

        case 'PUT':
          if (!resourceId) {
            return createErrorResponse(400, 'Resource ID required');
          }
          
          if (!hasPermission(user, tableConfig.name, 'update')) {
            return createErrorResponse(403, 'Forbidden');
          }

          try {
            const body = JSON.parse(event.body || '{}');
            const item = {
              ...body,
              pk: tableConfig.name,
              sk: resourceId,
              [tableConfig.pk]: resourceId
            };
            addTimestamps(item, true);

            await docClient.send(new PutCommand({
              TableName: TABLE_NAME,
              Item: item
            }));

            await writeAuditLog(user, 'UPDATE', tableConfig.name, { id: resourceId });
            return createResponse(200, item);
          } catch (error) {
            return createErrorResponse(500, 'Internal server error');
          }

        case 'DELETE':
          if (!resourceId) {
            return createErrorResponse(400, 'Resource ID required');
          }
          
          if (!hasPermission(user, tableConfig.name, 'delete')) {
            return createErrorResponse(403, 'Forbidden');
          }

          try {
            await docClient.send(new DeleteCommand({
              TableName: TABLE_NAME,
              Key: {
                pk: tableConfig.name,
                sk: resourceId
              }
            }));

            await writeAuditLog(user, 'DELETE', tableConfig.name, { id: resourceId });
            return createResponse(200, { message: 'Resource deleted successfully' });
          } catch (error) {
            return createErrorResponse(500, 'Internal server error');
          }

        default:
          return createErrorResponse(405, 'Method not allowed');
      }
    }

    return createErrorResponse(404, 'Not found');
  } catch (error) {
    console.error('Handler error:', error);
    return createErrorResponse(500, 'Internal server error');
  }
};