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
    if (!item[field]) {
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

async function handleList(tableIndex: string, user: User): Promise<APIResponse> {
  if (!hasPermission(user, 'resources', 'read')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
  if (!config) {
    return createResponse(404, { error: 'Table not found' });
  }

  try {
    const command = new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'begins_with(pk, :pkPrefix)',
      ExpressionAttributeValues: {
        ':pkPrefix': config.name
      }
    });

    const result = await docClient.send(command);
    return createResponse(200, {
      items: result.Items || [],
      count: result.Count || 0
    });
  } catch (error) {
    console.error('List operation failed:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleGet(tableIndex: string, id: string, user: User): Promise<APIResponse> {
  if (!hasPermission(user, 'resources', 'read')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
  if (!config) {
    return createResponse(404, { error: 'Table not found' });
  }

  try {
    const command = new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: `${config.name}_${id}`,
        sk: id
      }
    });

    const result = await docClient.send(command);
    if (!result.Item) {
      return createResponse(404, { error: 'Item not found' });
    }

    return createResponse(200, result.Item);
  } catch (error) {
    console.error('Get operation failed:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleCreate(tableIndex: string, data: any, user: User): Promise<APIResponse> {
  if (!hasPermission(user, 'resources', 'create')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
  if (!config) {
    return createResponse(404, { error: 'Table not found' });
  }

  const requiredFields = getRequiredFields(tableIndex);
  const validationErrors = validateRequired(data, requiredFields);
  if (validationErrors.length > 0) {
    return createResponse(400, { error: 'Validation failed', details: validationErrors });
  }

  try {
    const id = randomUUID();
    const now = new Date().toISOString();
    const item = {
      ...data,
      [config.pk]: id,
      pk: `${config.name}_${id}`,
      sk: id,
      createdAt: now,
      updatedAt: now
    };

    const command = new PutCommand({
      TableName: TABLE_NAME,
      Item: item
    });

    await docClient.send(command);
    await writeAuditLog(user, 'CREATE', config.displayName, { id });

    return createResponse(201, item);
  } catch (error) {
    console.error('Create operation failed:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleUpdate(tableIndex: string, id: string, data: any, user: User): Promise<APIResponse> {
  if (!hasPermission(user, 'resources', 'update')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
  if (!config) {
    return createResponse(404, { error: 'Table not found' });
  }

  try {
    const now = new Date().toISOString();
    const updateExpression = 'SET updatedAt = :updatedAt';
    const expressionAttributeValues: any = { ':updatedAt': now };
    const expressionAttributeNames: any = {};

    let updateExpr = updateExpression;
    Object.keys(data).forEach((key, index) => {
      if (key !== 'pk' && key !== 'sk' && key !== config.pk) {
        const attrName = `#attr${index}`;
        const attrValue = `:val${index}`;
        updateExpr += `, ${attrName} = ${attrValue}`;
        expressionAttributeNames[attrName] = key;
        expressionAttributeValues[attrValue] = data[key];
      }
    });

    const command = new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: `${config.name}_${id}`,
        sk: id
      },
      UpdateExpression: updateExpr,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW'
    });

    const result = await docClient.send(command);
    await writeAuditLog(user, 'UPDATE', config.displayName, { id });

    return createResponse(200, result.Attributes);
  } catch (error) {
    console.error('Update operation failed:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleDelete(tableIndex: string, id: string, user: User): Promise<APIResponse> {
  if (!hasPermission(user, 'resources', 'delete')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
  if (!config) {
    return createResponse(404, { error: 'Table not found' });
  }

  try {
    const command = new DeleteCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: `${config.name}_${id}`,
        sk: id
      },
      ReturnValues: 'ALL_OLD'
    });

    const result = await docClient.send(command);
    if (!result.Attributes) {
      return createResponse(404, { error: 'Item not found' });
    }

    await writeAuditLog(user, 'DELETE', config.displayName, { id });
    return createResponse(200, { message: 'Item deleted successfully' });
  } catch (error) {
    console.error('Delete operation failed:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleBulkImport(tableIndex: string, items: any[], user: User): Promise<APIResponse> {
  if (!hasPermission(user, 'resources', 'bulk')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
  if (!config) {
    return createResponse(404, { error: 'Table not found' });
  }

  if (!Array.isArray(items) || items.length === 0) {
    return createResponse(400, { error: 'Items array is required and must not be empty' });
  }

  const requiredFields = getRequiredFields(tableIndex);
  let imported = 0;
  let failed = 0;
  const errors: string[] = [];

  try {
    // Process in batches of 25 (DynamoDB BatchWrite limit)
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

        const id = randomUUID();
        const now = new Date().toISOString();
        const processedItem = {
          ...item,
          [config.pk]: id,
          pk: `${config.name}_${id}`,
          sk: id,
          createdAt: now,
          updatedAt: now
        };

        writeRequests.push({
          PutRequest: {
            Item: processedItem
          }
        });
      }

      if (writeRequests.length > 0) {
        const batchCommand = new BatchWriteCommand({
          RequestItems: {
            [TABLE_NAME]: writeRequests
          }
        });

        const result = await docClient.send(batchCommand);
        imported += writeRequests.length - (result.UnprocessedItems?.[TABLE_NAME]?.length || 0);
        
        if (result.UnprocessedItems?.[TABLE_NAME]?.length) {
          failed += result.UnprocessedItems[TABLE_NAME].length;
          errors.push(`${result.UnprocessedItems[TABLE_NAME].length} items failed to process in batch`);
        }
      }
    }

    await writeAuditLog(user, 'BULK_IMPORT', config.displayName, { imported, failed, totalItems: items.length });

    return createResponse(200, {
      imported,
      failed,
      errors
    });
  } catch (error) {
    console.error('Bulk import failed:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

export const handler = async (event: any): Promise<APIResponse> => {
  try {
    const user = extractUserFromEvent(event);
    const method = event.httpMethod;
    const path = event.path;
    const pathParams = event.pathParameters || {};
    
    // Handle CORS preflight
    if (method === 'OPTIONS') {
      return createResponse(200, {});
    }

    // Parse path for table operations
    const pathMatch = path.match(/^\/api\/(\d+)(?:\/(\w+))?(?:\/(\w+))?$/);
    if (!pathMatch) {
      return createResponse(404, { error: 'Invalid path' });
    }

    const [, tableIndex, operation, id] = pathMatch;

    // Handle bulk import
    if (method === 'POST' && operation === 'bulk') {
      const body = JSON.parse(event.body || '{}');
      return await handleBulkImport(tableIndex, body.items || [], user);
    }

    // Handle CRUD operations
    switch (method) {
      case 'GET':
        if (id) {
          return await handleGet(tableIndex, id, user);
        } else {
          return await handleList(tableIndex, user);
        }
      
      case 'POST':
        const createBody = JSON.parse(event.body || '{}');
        return await handleCreate(tableIndex, createBody, user);
      
      case 'PUT':
        if (!id) {
          return createResponse(400, { error: 'ID is required for update' });
        }
        const updateBody = JSON.parse(event.body || '{}');
        return await handleUpdate(tableIndex, id, updateBody, user);
      
      case 'DELETE':
        if (!id) {
          return createResponse(400, { error: 'ID is required for delete' });
        }
        return await handleDelete(tableIndex, id, user);
      
      default:
        return createResponse(405, { error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Handler error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};