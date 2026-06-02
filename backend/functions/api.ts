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
  '4': { name: 'demand_forecast_reports', pk: 'forecastReportId', displayName: '需要予測レポート' },
  '5': { name: 'monthly_summary', pk: 'summaryId', displayName: '月次集計データ' },
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
    details,
    timestamp: new Date().toISOString()
  };
  
  try {
    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: auditRecord
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
    '0': ['storeCode', 'storeName', 'storeCategory', 'prefecture', 'city', 'transactionStartDate', 'transactionStatus', 'isActive', 'createdBy', 'updatedBy'],
    '1': ['storeId', 'customerName', 'productName', 'category', 'capacityMl', 'remainingMl', 'remainingPercent', 'keepStartDate', 'status', 'createdBy'],
    '2': ['memberId', 'storeId', 'visitDateTime', 'keepBottleUsed', 'newBottleOrdered', 'createdBy'],
    '3': ['storeId', 'keepBottleId', 'memberId', 'consumptionDateTime', 'consumptionAmount', 'remainingAmount', 'isCompleted', 'createdBy'],
    '4': ['storeId', 'productCategory', 'forecastPeriodStart', 'forecastPeriodEnd', 'forecastDemand', 'confidenceLevel', 'seasonalFactor', 'eventFactor', 'recommendedPurchase', 'createdBy'],
    '5': ['storeId', 'summaryYearMonth', 'productCategory', 'newKeepBottles', 'completedBottles', 'totalConsumption', 'visitCount', 'activeMemberCount', 'averageConsumption', 'createdBy'],
    '6': ['analysisYear', 'analysisMonth', 'alcoholCategory', 'regionCode', 'baseConsumption', 'actualConsumption', 'seasonalIndex', 'eventInfluence', 'createdBy'],
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
    
    if (path === '/resources' && method === 'GET') {
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

    const tableIndexMatch = path.match(/\/api\/(\d+)/);
    if (!tableIndexMatch) {
      return createResponse(404, { error: 'Not found' });
    }
    
    const tableIndex = tableIndexMatch[1];
    const tableConfig = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    
    if (!tableConfig) {
      return createResponse(404, { error: 'Table not found' });
    }

    const isBulkEndpoint = path.includes('/bulk');
    const isDetailEndpoint = pathParams.id;
    
    if (isBulkEndpoint && method === 'POST') {
      if (!hasPermission(user, tableConfig.name, 'bulk')) {
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
          
          const now = new Date().toISOString();
          const processedItem = {
            ...item,
            [tableConfig.pk]: item[tableConfig.pk] || randomUUID(),
            pk: `${tableConfig.name.toUpperCase()}_${item[tableConfig.pk] || randomUUID()}`,
            sk: item[tableConfig.pk] || randomUUID(),
            createdAt: now,
            updatedAt: now,
            createdBy: item.createdBy || user.id,
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
      
      await writeAuditLog(user, 'BULK_IMPORT', tableConfig.displayName, { imported, failed, totalItems: items.length });
      
      return createResponse(200, { imported, failed, errors });
    }
    
    if (method === 'GET' && !isDetailEndpoint) {
      if (!hasPermission(user, tableConfig.name, 'read')) {
        return createResponse(403, { error: 'Forbidden' });
      }
      
      try {
        const result = await docClient.send(new ScanCommand({
          TableName: TABLE_NAME,
          FilterExpression: 'begins_with(pk, :pkPrefix)',
          ExpressionAttributeValues: {
            ':pkPrefix': tableConfig.name.toUpperCase()
          }
        }));
        
        return createResponse(200, { items: result.Items || [] });
      } catch (error) {
        return createResponse(500, { error: 'Internal server error' });
      }
    }
    
    if (method === 'GET' && isDetailEndpoint) {
      if (!hasPermission(user, tableConfig.name, 'read')) {
        return createResponse(403, { error: 'Forbidden' });
      }
      
      try {
        const result = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: `${tableConfig.name.toUpperCase()}_${pathParams.id}`,
            sk: pathParams.id
          }
        }));
        
        if (!result.Item) {
          return createResponse(404, { error: 'Item not found' });
        }
        
        return createResponse(200, result.Item);
      } catch (error) {
        return createResponse(500, { error: 'Internal server error' });
      }
    }
    
    if (method === 'POST' && !isDetailEndpoint && !isBulkEndpoint) {
      if (!hasPermission(user, tableConfig.name, 'create')) {
        return createResponse(403, { error: 'Forbidden' });
      }
      
      const body = JSON.parse(event.body || '{}');
      const requiredFields = getRequiredFields(tableIndex);
      const validationErrors = validateRequired(body, requiredFields);
      
      if (validationErrors.length > 0) {
        return createResponse(400, { error: 'Validation failed', details: validationErrors });
      }
      
      const id = body[tableConfig.pk] || randomUUID();
      const now = new Date().toISOString();
      
      const item = {
        ...body,
        [tableConfig.pk]: id,
        pk: `${tableConfig.name.toUpperCase()}_${id}`,
        sk: id,
        createdAt: now,
        updatedAt: now,
        createdBy: body.createdBy || user.id,
        updatedBy: user.id
      };
      
      try {
        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: item
        }));
        
        await writeAuditLog(user, 'CREATE', tableConfig.displayName, { id });
        
        return createResponse(201, item);
      } catch (error) {
        return createResponse(500, { error: 'Internal server error' });
      }
    }
    
    if (method === 'PUT' && isDetailEndpoint) {
      if (!hasPermission(user, tableConfig.name, 'update')) {
        return createResponse(403, { error: 'Forbidden' });
      }
      
      const body = JSON.parse(event.body || '{}');
      const now = new Date().toISOString();
      
      try {
        const result = await docClient.send(new UpdateCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: `${tableConfig.name.toUpperCase()}_${pathParams.id}`,
            sk: pathParams.id
          },
          UpdateExpression: 'SET updatedAt = :updatedAt, updatedBy = :updatedBy',
          ExpressionAttributeValues: {
            ':updatedAt': now,
            ':updatedBy': user.id,
            ...Object.keys(body).reduce((acc, key) => {
              if (key !== tableConfig.pk && key !== 'pk' && key !== 'sk') {
                acc[`:${key}`] = body[key];
              }
              return acc;
            }, {} as Record<string, any>)
          },
          UpdateExpression: `SET updatedAt = :updatedAt, updatedBy = :updatedBy${Object.keys(body).filter(key => key !== tableConfig.pk && key !== 'pk' && key !== 'sk').map(key => `, ${key} = :${key}`).join('')}`,
          ReturnValues: 'ALL_NEW'
        }));
        
        await writeAuditLog(user, 'UPDATE', tableConfig.displayName, { id: pathParams.id });
        
        return createResponse(200, result.Attributes);
      } catch (error) {
        return createResponse(500, { error: 'Internal server error' });
      }
    }
    
    if (method === 'DELETE' && isDetailEndpoint) {
      if (!hasPermission(user, tableConfig.name, 'delete')) {
        return createResponse(403, { error: 'Forbidden' });
      }
      
      try {
        await docClient.send(new DeleteCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: `${tableConfig.name.toUpperCase()}_${pathParams.id}`,
            sk: pathParams.id
          }
        }));
        
        await writeAuditLog(user, 'DELETE', tableConfig.displayName, { id: pathParams.id });
        
        return createResponse(204, {});
      } catch (error) {
        return createResponse(500, { error: 'Internal server error' });
      }
    }
    
    return createResponse(404, { error: 'Not found' });
    
  } catch (error) {
    console.error('Handler error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};