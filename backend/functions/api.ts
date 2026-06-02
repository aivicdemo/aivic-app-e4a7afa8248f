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

interface APIGatewayEvent {
  httpMethod: string;
  pathParameters: { [key: string]: string } | null;
  queryStringParameters: { [key: string]: string } | null;
  body: string | null;
  headers: { [key: string]: string };
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

async function writeAuditLog(user: User, action: string, resource: string, details: any = {}) {
  const auditRecord = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    userId: user.id,
    userRole: user.role,
    action,
    resource,
    timestamp: new Date().toISOString(),
    details
  };
  
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditRecord
  }));
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

function getRequiredFieldsByTableIndex(tableIndex: string): string[] {
  const fieldMap: { [key: string]: string[] } = {
    '0': ['storeCode', 'storeName', 'storeCategory', 'prefecture', 'city', 'transactionStartDate', 'transactionStatus', 'validFlag', 'createdBy', 'updatedBy'],
    '1': ['storeId', 'customerName', 'productName', 'category', 'capacityMl', 'remainingMl', 'remainingPercent', 'keepStartDate', 'status', 'createdBy'],
    '2': ['memberId', 'storeId', 'visitDateTime', 'keepBottleUsedFlag', 'newBottleOrderFlag', 'createdBy'],
    '3': ['storeId', 'keepBottleId', 'memberId', 'consumptionDateTime', 'consumptionAmount', 'remainingAmount', 'completedFlag', 'createdBy'],
    '4': ['storeId', 'productCategory', 'forecastPeriodStart', 'forecastPeriodEnd', 'forecastDemand', 'confidenceLevel', 'seasonalFlag', 'eventFlag', 'recommendedPurchase', 'createdBy'],
    '5': ['storeId', 'summaryYearMonth', 'productCategory', 'newKeepBottles', 'completedBottles', 'totalConsumption', 'visitCount', 'activeMemberCount', 'averageConsumption', 'createdBy'],
    '6': ['analysisYear', 'analysisMonth', 'alcoholCategory', 'regionCode', 'baseConsumption', 'actualConsumption', 'seasonalIndex', 'eventInfluenceFlag', 'createdBy'],
    '7': ['storeId', 'productCode', 'productName', 'planPeriodStart', 'planPeriodEnd', 'currentStock', 'forecastDemand', 'safetyStock', 'plannedReplenishment', 'scheduledDate', 'planStatus', 'priority', 'createdBy'],
    '8': ['storeId', 'productCode', 'productName', 'scheduledDeliveryDate', 'scheduledQuantity', 'deliveryStatus', 'createdBy'],
    '9': ['routeName', 'driverUserId', 'vehicleId', 'startLocation', 'endLocation', 'estimatedDuration', 'totalDistance', 'maxCapacity', 'deliveryDays', 'startTime', 'validFlag', 'createdBy'],
    '10': ['loginId', 'passwordHash', 'userName', 'email', 'permissionLevel', 'organization', 'accountStatus', 'createdBy']
  };
  return fieldMap[tableIndex] || [];
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
    
    if (pathParts[0] === 'resources') {
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

    if (pathParts[0] === 'api' && pathParts[1] && TABLE_CONFIGS[pathParts[1] as keyof typeof TABLE_CONFIGS]) {
      const tableIndex = pathParts[1];
      const tableConfig = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
      const resourceName = tableConfig.name;
      
      if (pathParts[2] === 'bulk' && event.httpMethod === 'POST') {
        if (!hasPermission(user, resourceName, 'bulk')) {
          return createResponse(403, { error: 'Forbidden' });
        }
        
        let requestBody;
        try {
          requestBody = JSON.parse(event.body || '{}');
        } catch (error) {
          return createResponse(400, { error: 'Invalid JSON in request body' });
        }
        
        if (!requestBody.items || !Array.isArray(requestBody.items)) {
          return createResponse(400, { error: 'items array is required' });
        }
        
        const requiredFields = getRequiredFieldsByTableIndex(tableIndex);
        let imported = 0;
        let failed = 0;
        const errors: string[] = [];
        
        const chunks = [];
        for (let i = 0; i < requestBody.items.length; i += 25) {
          chunks.push(requestBody.items.slice(i, i + 25));
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
            
            const now = new Date().toISOString();
            const enrichedItem = {
              ...item,
              [tableConfig.pk]: item[tableConfig.pk] || randomUUID(),
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
              errors.push(`Batch write failed: ${error}`);
            }
          }
        }
        
        await writeAuditLog(user, 'BULK_IMPORT', resourceName, { imported, failed, totalItems: requestBody.items.length });
        
        return createResponse(200, { imported, failed, errors });
      }
      
      if (event.httpMethod === 'GET' && !pathParts[2]) {
        if (!hasPermission(user, resourceName, 'read')) {
          return createResponse(403, { error: 'Forbidden' });
        }
        
        try {
          const result = await docClient.send(new ScanCommand({
            TableName: TABLE_NAME,
            FilterExpression: 'begins_with(#pk, :prefix)',
            ExpressionAttributeNames: { '#pk': tableConfig.pk },
            ExpressionAttributeValues: { ':prefix': tableConfig.name }
          }));
          
          return createResponse(200, { items: result.Items || [] });
        } catch (error) {
          return createResponse(500, { error: 'Internal server error' });
        }
      }
      
      if (event.httpMethod === 'GET' && pathParts[2]) {
        if (!hasPermission(user, resourceName, 'read')) {
          return createResponse(403, { error: 'Forbidden' });
        }
        
        try {
          const result = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: { [tableConfig.pk]: pathParts[2] }
          }));
          
          if (!result.Item) {
            return createResponse(404, { error: 'Item not found' });
          }
          
          return createResponse(200, result.Item);
        } catch (error) {
          return createResponse(500, { error: 'Internal server error' });
        }
      }
      
      if (event.httpMethod === 'POST') {
        if (!hasPermission(user, resourceName, 'create')) {
          return createResponse(403, { error: 'Forbidden' });
        }
        
        let requestBody;
        try {
          requestBody = JSON.parse(event.body || '{}');
        } catch (error) {
          return createResponse(400, { error: 'Invalid JSON in request body' });
        }
        
        const requiredFields = getRequiredFieldsByTableIndex(tableIndex);
        const validationErrors = validateRequiredFields(requestBody, requiredFields);
        if (validationErrors.length > 0) {
          return createResponse(400, { error: 'Validation failed', details: validationErrors });
        }
        
        const now = new Date().toISOString();
        const item = {
          ...requestBody,
          [tableConfig.pk]: requestBody[tableConfig.pk] || randomUUID(),
          createdAt: now,
          updatedAt: now,
          createdBy: requestBody.createdBy || user.id,
          updatedBy: user.id
        };
        
        try {
          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: item
          }));
          
          await writeAuditLog(user, 'CREATE', resourceName, { itemId: item[tableConfig.pk] });
          
          return createResponse(201, item);
        } catch (error) {
          return createResponse(500, { error: 'Internal server error' });
        }
      }
      
      if (event.httpMethod === 'PUT' && pathParts[2]) {
        if (!hasPermission(user, resourceName, 'update')) {
          return createResponse(403, { error: 'Forbidden' });
        }
        
        let requestBody;
        try {
          requestBody = JSON.parse(event.body || '{}');
        } catch (error) {
          return createResponse(400, { error: 'Invalid JSON in request body' });
        }
        
        const itemId = pathParts[2];
        
        try {
          const existingItem = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: { [tableConfig.pk]: itemId }
          }));
          
          if (!existingItem.Item) {
            return createResponse(404, { error: 'Item not found' });
          }
          
          const updatedItem = {
            ...existingItem.Item,
            ...requestBody,
            [tableConfig.pk]: itemId,
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
          return createResponse(500, { error: 'Internal server error' });
        }
      }
      
      if (event.httpMethod === 'DELETE' && pathParts[2]) {
        if (!hasPermission(user, resourceName, 'delete')) {
          return createResponse(403, { error: 'Forbidden' });
        }
        
        const itemId = pathParts[2];
        
        try {
          const existingItem = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: { [tableConfig.pk]: itemId }
          }));
          
          if (!existingItem.Item) {
            return createResponse(404, { error: 'Item not found' });
          }
          
          await docClient.send(new DeleteCommand({
            TableName: TABLE_NAME,
            Key: { [tableConfig.pk]: itemId }
          }));
          
          await writeAuditLog(user, 'DELETE', resourceName, { itemId });
          
          return createResponse(200, { message: 'Item deleted successfully' });
        } catch (error) {
          return createResponse(500, { error: 'Internal server error' });
        }
      }
    }
    
    return createResponse(404, { error: 'Not found' });
    
  } catch (error) {
    console.error('Unhandled error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};