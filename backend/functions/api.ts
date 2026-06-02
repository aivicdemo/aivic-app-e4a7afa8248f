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
  try {
    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        pk: 'AUDIT',
        sk: `${Date.now()}_${randomUUID()}`,
        userId: user.id,
        userRole: user.role,
        action,
        resource,
        details,
        timestamp: new Date().toISOString()
      }
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

function getRequiredFieldsByTableIndex(tableIndex: string): string[] {
  const fieldMap: Record<string, string[]> = {
    '0': ['storeCode', 'storeName', 'storeCategory', 'prefecture', 'city', 'transactionStartDate', 'transactionStatus', 'isActive', 'createdBy', 'updatedBy'],
    '1': ['storeId', 'customerName', 'productName', 'category', 'capacityMl', 'remainingMl', 'remainingPercent', 'keepStartDate', 'status', 'createdBy'],
    '2': ['memberId', 'storeId', 'visitDateTime', 'keepBottleUsed', 'newBottleOrdered', 'createdBy'],
    '3': ['storeId', 'keepBottleId', 'memberId', 'consumptionDateTime', 'consumptionAmount', 'remainingAmount', 'isCompletelyConsumed', 'createdBy'],
    '4': ['storeId', 'productCategory', 'forecastPeriodStart', 'forecastPeriodEnd', 'forecastDemand', 'confidenceLevel', 'seasonalFactor', 'eventFactor', 'recommendedPurchaseAmount', 'createdBy'],
    '5': ['storeId', 'summaryYearMonth', 'productCategory', 'newKeepBottles', 'completedBottles', 'totalConsumption', 'visitCount', 'activeMemberCount', 'averageConsumption', 'createdBy'],
    '6': ['analysisYear', 'analysisMonth', 'alcoholCategory', 'regionCode', 'baseConsumption', 'actualConsumption', 'seasonalIndex', 'eventInfluence', 'createdBy'],
    '7': ['storeId', 'productCode', 'productName', 'planPeriodStart', 'planPeriodEnd', 'currentStock', 'forecastDemand', 'safetyStock', 'plannedReplenishment', 'scheduledDate', 'planStatus', 'priority', 'createdBy'],
    '8': ['storeId', 'productCode', 'productName', 'scheduledDeliveryDate', 'scheduledQuantity', 'deliveryStatus', 'createdBy'],
    '9': ['routeName', 'driverId', 'vehicleId', 'startLocation', 'endLocation', 'estimatedDuration', 'totalDistance', 'maxCapacity', 'deliveryDays', 'startTime', 'isActive', 'createdBy'],
    '10': ['loginId', 'passwordHash', 'userName', 'email', 'permissionLevel', 'organization', 'accountStatus', 'createdBy']
  };
  return fieldMap[tableIndex] || [];
}

async function handleGetResources(event: any, user: User): Promise<APIResponse> {
  if (!hasPermission(user, 'resources', 'read')) {
    return createErrorResponse(403, 'Insufficient permissions');
  }

  try {
    const result = await docClient.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'pk <> :auditPk',
      ExpressionAttributeValues: {
        ':auditPk': 'AUDIT'
      }
    }));

    return createResponse(200, {
      items: result.Items || [],
      count: result.Count || 0
    });
  } catch (error) {
    console.error('Error fetching resources:', error);
    return createErrorResponse(500, 'Internal server error');
  }
}

async function handleGetTableItems(event: any, user: User, tableIndex: string): Promise<APIResponse> {
  const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
  if (!config) {
    return createErrorResponse(404, 'Table not found');
  }

  if (!hasPermission(user, config.name, 'read')) {
    return createErrorResponse(403, 'Insufficient permissions');
  }

  try {
    const result = await docClient.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'pk = :pk',
      ExpressionAttributeValues: {
        ':pk': config.name
      }
    }));

    return createResponse(200, {
      items: result.Items || [],
      count: result.Count || 0,
      tableName: config.displayName
    });
  } catch (error) {
    console.error(`Error fetching ${config.name}:`, error);
    return createErrorResponse(500, 'Internal server error');
  }
}

async function handleGetTableItem(event: any, user: User, tableIndex: string, itemId: string): Promise<APIResponse> {
  const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
  if (!config) {
    return createErrorResponse(404, 'Table not found');
  }

  if (!hasPermission(user, config.name, 'read')) {
    return createErrorResponse(403, 'Insufficient permissions');
  }

  try {
    const result = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: config.name,
        sk: itemId
      }
    }));

    if (!result.Item) {
      return createErrorResponse(404, 'Item not found');
    }

    return createResponse(200, result.Item);
  } catch (error) {
    console.error(`Error fetching ${config.name} item:`, error);
    return createErrorResponse(500, 'Internal server error');
  }
}

async function handleCreateTableItem(event: any, user: User, tableIndex: string): Promise<APIResponse> {
  const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
  if (!config) {
    return createErrorResponse(404, 'Table not found');
  }

  if (!hasPermission(user, config.name, 'create')) {
    return createErrorResponse(403, 'Insufficient permissions');
  }

  let requestBody;
  try {
    requestBody = JSON.parse(event.body || '{}');
  } catch {
    return createErrorResponse(400, 'Invalid JSON in request body');
  }

  const requiredFields = getRequiredFieldsByTableIndex(tableIndex);
  const validationErrors = validateRequiredFields(requestBody, requiredFields);
  if (validationErrors.length > 0) {
    return createErrorResponse(400, `Validation errors: ${validationErrors.join(', ')}`);
  }

  const itemId = randomUUID();
  const now = new Date().toISOString();
  
  const item = {
    pk: config.name,
    sk: itemId,
    [config.pk]: itemId,
    ...requestBody,
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

    await writeAuditLog(user, 'CREATE', config.name, { itemId, tableName: config.displayName });

    return createResponse(201, item);
  } catch (error) {
    console.error(`Error creating ${config.name} item:`, error);
    return createErrorResponse(500, 'Internal server error');
  }
}

async function handleUpdateTableItem(event: any, user: User, tableIndex: string, itemId: string): Promise<APIResponse> {
  const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
  if (!config) {
    return createErrorResponse(404, 'Table not found');
  }

  if (!hasPermission(user, config.name, 'update')) {
    return createErrorResponse(403, 'Insufficient permissions');
  }

  let requestBody;
  try {
    requestBody = JSON.parse(event.body || '{}');
  } catch {
    return createErrorResponse(400, 'Invalid JSON in request body');
  }

  try {
    const existingItem = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: config.name,
        sk: itemId
      }
    }));

    if (!existingItem.Item) {
      return createErrorResponse(404, 'Item not found');
    }

    const updateExpressions: string[] = [];
    const expressionAttributeNames: Record<string, string> = {};
    const expressionAttributeValues: Record<string, any> = {};

    Object.keys(requestBody).forEach((key, index) => {
      if (key !== 'pk' && key !== 'sk' && key !== 'createdAt' && key !== 'createdBy') {
        const attrName = `#attr${index}`;
        const attrValue = `:val${index}`;
        updateExpressions.push(`${attrName} = ${attrValue}`);
        expressionAttributeNames[attrName] = key;
        expressionAttributeValues[attrValue] = requestBody[key];
      }
    });

    updateExpressions.push('#updatedAt = :updatedAt');
    updateExpressions.push('#updatedBy = :updatedBy');
    expressionAttributeNames['#updatedAt'] = 'updatedAt';
    expressionAttributeNames['#updatedBy'] = 'updatedBy';
    expressionAttributeValues[':updatedAt'] = new Date().toISOString();
    expressionAttributeValues[':updatedBy'] = user.id;

    const result = await docClient.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: config.name,
        sk: itemId
      },
      UpdateExpression: `SET ${updateExpressions.join(', ')}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW'
    }));

    await writeAuditLog(user, 'UPDATE', config.name, { itemId, tableName: config.displayName, changes: requestBody });

    return createResponse(200, result.Attributes);
  } catch (error) {
    console.error(`Error updating ${config.name} item:`, error);
    return createErrorResponse(500, 'Internal server error');
  }
}

async function handleDeleteTableItem(event: any, user: User, tableIndex: string, itemId: string): Promise<APIResponse> {
  const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
  if (!config) {
    return createErrorResponse(404, 'Table not found');
  }

  if (!hasPermission(user, config.name, 'delete')) {
    return createErrorResponse(403, 'Insufficient permissions');
  }

  try {
    const existingItem = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: config.name,
        sk: itemId
      }
    }));

    if (!existingItem.Item) {
      return createErrorResponse(404, 'Item not found');
    }

    await docClient.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: config.name,
        sk: itemId
      }
    }));

    await writeAuditLog(user, 'DELETE', config.name, { itemId, tableName: config.displayName });

    return createResponse(200, { message: 'Item deleted successfully' });
  } catch (error) {
    console.error(`Error deleting ${config.name} item:`, error);
    return createErrorResponse(500, 'Internal server error');
  }
}

async function handleBulkImport(event: any, user: User, tableIndex: string): Promise<APIResponse> {
  const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
  if (!config) {
    return createErrorResponse(404, 'Table not found');
  }

  if (!hasPermission(user, config.name, 'bulk')) {
    return createErrorResponse(403, 'Insufficient permissions');
  }

  let requestBody;
  try {
    requestBody = JSON.parse(event.body || '{}');
  } catch {
    return createErrorResponse(400, 'Invalid JSON in request body');
  }

  if (!requestBody.items || !Array.isArray(requestBody.items)) {
    return createErrorResponse(400, 'Request body must contain an "items" array');
  }

  const items = requestBody.items;
  const requiredFields = getRequiredFieldsByTableIndex(tableIndex);
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
      const validationErrors = validateRequiredFields(item, requiredFields);
      if (validationErrors.length > 0) {
        failed++;
        errors.push(`Item validation failed: ${validationErrors.join(', ')}`);
        continue;
      }

      const itemId = randomUUID();
      const now = new Date().toISOString();
      
      const processedItem = {
        pk: config.name,
        sk: itemId,
        [config.pk]: itemId,
        ...item,
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

  await writeAuditLog(user, 'BULK_IMPORT', config.name, { 
    tableName: config.displayName, 
    imported, 
    failed, 
    totalAttempted: items.length 
  });

  return createResponse(200, {
    imported,
    failed,
    errors
  });
}

export const handler = async (event: any): Promise<APIResponse> => {
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
  const pathSegments = path.split('/').filter(Boolean);

  try {
    if (method === 'GET' && pathSegments.length === 1 && pathSegments[0] === 'resources') {
      return await handleGetResources(event, user);
    }

    if (pathSegments.length >= 2 && pathSegments[0] === 'api') {
      const tableIndex = pathSegments[1];
      
      if (method === 'GET' && pathSegments.length === 2) {
        return await handleGetTableItems(event, user, tableIndex);
      }
      
      if (method === 'GET' && pathSegments.length === 3) {
        const itemId = pathSegments[2];
        return await handleGetTableItem(event, user, tableIndex, itemId);
      }
      
      if (method === 'POST' && pathSegments.length === 2) {
        return await handleCreateTableItem(event, user, tableIndex);
      }
      
      if (method === 'POST' && pathSegments.length === 3 && pathSegments[2] === 'bulk') {
        return await handleBulkImport(event, user, tableIndex);
      }
      
      if (method === 'PUT' && pathSegments.length === 3) {
        const itemId = pathSegments[2];
        return await handleUpdateTableItem(event, user, tableIndex, itemId);
      }
      
      if (method === 'DELETE' && pathSegments.length === 3) {
        const itemId = pathSegments[2];
        return await handleDeleteTableItem(event, user, tableIndex, itemId);
      }
    }

    return createErrorResponse(404, 'Endpoint not found');
  } catch (error) {
    console.error('Unhandled error:', error);
    return createErrorResponse(500, 'Internal server error');
  }
};