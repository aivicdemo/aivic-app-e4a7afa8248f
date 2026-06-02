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

function validateTableIndex(tableIndex: string): boolean {
  return tableIndex in TABLE_CONFIGS;
}

function addTimestamps(item: any, isUpdate: boolean = false): any {
  const now = new Date().toISOString();
  if (!isUpdate) {
    item.createdAt = now;
  }
  item.updatedAt = now;
  return item;
}

function validateRequiredFields(item: any, tableIndex: string): string[] {
  const errors: string[] = [];
  const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
  
  if (!item[config.pk]) {
    errors.push(`${config.pk} is required`);
  }
  
  return errors;
}

async function handleGetResources(event: any, user: User): Promise<APIResponse> {
  if (!hasPermission(user, 'resources', 'read')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  try {
    const resources = Object.entries(TABLE_CONFIGS).map(([index, config]) => ({
      index,
      name: config.name,
      displayName: config.displayName,
      primaryKey: config.pk
    }));

    return createResponse(200, { resources });
  } catch (error) {
    console.error('Error getting resources:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleGetTableData(event: any, user: User, tableIndex: string): Promise<APIResponse> {
  if (!hasPermission(user, 'table', 'read')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  if (!validateTableIndex(tableIndex)) {
    return createResponse(404, { error: 'Table not found' });
  }

  try {
    const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    const command = new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'begins_with(pk, :pkPrefix)',
      ExpressionAttributeValues: {
        ':pkPrefix': config.name
      }
    });

    const result = await docClient.send(command);
    return createResponse(200, { items: result.Items || [] });
  } catch (error) {
    console.error('Error scanning table:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleGetTableItem(event: any, user: User, tableIndex: string, itemId: string): Promise<APIResponse> {
  if (!hasPermission(user, 'table', 'read')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  if (!validateTableIndex(tableIndex)) {
    return createResponse(404, { error: 'Table not found' });
  }

  try {
    const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    const command = new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: `${config.name}_${itemId}`,
        sk: itemId
      }
    });

    const result = await docClient.send(command);
    if (!result.Item) {
      return createResponse(404, { error: 'Item not found' });
    }

    return createResponse(200, { item: result.Item });
  } catch (error) {
    console.error('Error getting item:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleCreateTableItem(event: any, user: User, tableIndex: string): Promise<APIResponse> {
  if (!hasPermission(user, 'table', 'create')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  if (!validateTableIndex(tableIndex)) {
    return createResponse(404, { error: 'Table not found' });
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    
    const itemId = body[config.pk] || randomUUID();
    const item = {
      ...body,
      pk: `${config.name}_${itemId}`,
      sk: itemId,
      [config.pk]: itemId,
      createdBy: user.id,
      updatedBy: user.id
    };

    addTimestamps(item);
    
    const validationErrors = validateRequiredFields(item, tableIndex);
    if (validationErrors.length > 0) {
      return createResponse(400, { error: 'Validation failed', details: validationErrors });
    }

    const command = new PutCommand({
      TableName: TABLE_NAME,
      Item: item
    });

    await docClient.send(command);
    await writeAuditLog(user, 'CREATE', `${config.displayName}`, { itemId });

    return createResponse(201, { item });
  } catch (error) {
    console.error('Error creating item:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleUpdateTableItem(event: any, user: User, tableIndex: string, itemId: string): Promise<APIResponse> {
  if (!hasPermission(user, 'table', 'update')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  if (!validateTableIndex(tableIndex)) {
    return createResponse(404, { error: 'Table not found' });
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    
    const item = {
      ...body,
      pk: `${config.name}_${itemId}`,
      sk: itemId,
      [config.pk]: itemId,
      updatedBy: user.id
    };

    addTimestamps(item, true);

    const command = new PutCommand({
      TableName: TABLE_NAME,
      Item: item
    });

    await docClient.send(command);
    await writeAuditLog(user, 'UPDATE', `${config.displayName}`, { itemId });

    return createResponse(200, { item });
  } catch (error) {
    console.error('Error updating item:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleDeleteTableItem(event: any, user: User, tableIndex: string, itemId: string): Promise<APIResponse> {
  if (!hasPermission(user, 'table', 'delete')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  if (!validateTableIndex(tableIndex)) {
    return createResponse(404, { error: 'Table not found' });
  }

  try {
    const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    const command = new DeleteCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: `${config.name}_${itemId}`,
        sk: itemId
      }
    });

    await docClient.send(command);
    await writeAuditLog(user, 'DELETE', `${config.displayName}`, { itemId });

    return createResponse(200, { message: 'Item deleted successfully' });
  } catch (error) {
    console.error('Error deleting item:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleBulkImport(event: any, user: User, tableIndex: string): Promise<APIResponse> {
  if (!hasPermission(user, 'table', 'bulk')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  if (!validateTableIndex(tableIndex)) {
    return createResponse(404, { error: 'Table not found' });
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const items = body.items || [];
    
    if (!Array.isArray(items)) {
      return createResponse(400, { error: 'Items must be an array' });
    }

    const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    let imported = 0;
    let failed = 0;
    const errors: string[] = [];

    // Process items in batches of 25 (DynamoDB BatchWrite limit)
    for (let i = 0; i < items.length; i += 25) {
      const batch = items.slice(i, i + 25);
      const writeRequests = batch.map(item => {
        const itemId = item[config.pk] || randomUUID();
        const processedItem = {
          ...item,
          pk: `${config.name}_${itemId}`,
          sk: itemId,
          [config.pk]: itemId,
          createdBy: user.id,
          updatedBy: user.id
        };
        addTimestamps(processedItem);
        
        return {
          PutRequest: {
            Item: processedItem
          }
        };
      });

      try {
        const command = new BatchWriteCommand({
          RequestItems: {
            [TABLE_NAME]: writeRequests
          }
        });

        await docClient.send(command);
        imported += batch.length;
      } catch (error) {
        failed += batch.length;
        errors.push(`Batch ${Math.floor(i / 25) + 1}: ${error}`);
      }
    }

    await writeAuditLog(user, 'BULK_IMPORT', `${config.displayName}`, { 
      totalItems: items.length,
      imported,
      failed 
    });

    return createResponse(200, { imported, failed, errors });
  } catch (error) {
    console.error('Error in bulk import:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

export const handler = async (event: any): Promise<APIResponse> => {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return createResponse(200, {});
    }

    const user = extractUserFromEvent(event);
    const path = event.path || event.rawPath || '';
    const method = event.httpMethod || event.requestContext?.http?.method || 'GET';
    
    // GET /resources
    if (method === 'GET' && path === '/resources') {
      return await handleGetResources(event, user);
    }

    // Table operations: /api/{tableIndex}/*
    const tableMatch = path.match(/^\/api\/(\d+)(?:\/(\w+))?(?:\/(\w+))?$/);
    if (tableMatch) {
      const [, tableIndex, action, itemId] = tableMatch;
      
      if (action === 'bulk' && method === 'POST') {
        return await handleBulkImport(event, user, tableIndex);
      }
      
      if (!action) {
        // /api/{tableIndex}
        if (method === 'GET') {
          return await handleGetTableData(event, user, tableIndex);
        }
        if (method === 'POST') {
          return await handleCreateTableItem(event, user, tableIndex);
        }
      } else if (itemId) {
        // /api/{tableIndex}/{itemId}
        if (method === 'GET') {
          return await handleGetTableItem(event, user, tableIndex, itemId);
        }
        if (method === 'PUT') {
          return await handleUpdateTableItem(event, user, tableIndex, itemId);
        }
        if (method === 'DELETE') {
          return await handleDeleteTableItem(event, user, tableIndex, itemId);
        }
      }
    }

    return createResponse(404, { error: 'Endpoint not found' });
  } catch (error) {
    console.error('Handler error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};