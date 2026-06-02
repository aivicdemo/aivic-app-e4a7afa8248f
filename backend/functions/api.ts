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
  '6': { name: 'seasonalVariationAnalysis', pk: 'seasonalVariationAnalysisId', displayName: '季節変動分析データ' },
  '7': { name: 'replenishmentPlan', pk: 'replenishmentPlanId', displayName: '補充計画' },
  '8': { name: 'deliverySchedule', pk: 'deliveryScheduleId', displayName: '納品スケジュール' },
  '9': { name: 'deliveryRoute', pk: 'deliveryRouteId', displayName: '配送ルート' },
  '10': { name: 'systemUser', pk: 'userId', displayName: 'システム利用者' }
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

async function createAuditLog(user: User, action: string, resource: string, details: any = {}) {
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

function validateRequiredFields(item: any, requiredFields: string[]): string[] {
  const errors: string[] = [];
  for (const field of requiredFields) {
    if (!item[field] && item[field] !== 0 && item[field] !== false) {
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
    '4': ['storeId', 'productCategory', 'forecastPeriodStart', 'forecastPeriodEnd', 'forecastDemand', 'confidenceLevel', 'seasonalFactorFlag', 'eventFactorFlag', 'recommendedPurchaseAmount', 'createdBy'],
    '5': ['storeId', 'aggregateYearMonth', 'productCategory', 'newKeepBottles', 'completedBottles', 'totalConsumption', 'totalVisitors', 'activeMembers', 'averageConsumption', 'createdBy'],
    '6': ['analysisYear', 'analysisMonth', 'alcoholCategory', 'regionCode', 'baseConsumption', 'actualConsumption', 'seasonalVariationIndex', 'eventInfluenceFlag', 'createdBy'],
    '7': ['storeId', 'productCode', 'productName', 'planPeriodStart', 'planPeriodEnd', 'currentStock', 'forecastDemand', 'safetyStock', 'plannedReplenishment', 'scheduledReplenishmentDate', 'planStatus', 'priority', 'createdBy'],
    '8': ['storeId', 'productCode', 'productName', 'scheduledDeliveryDate', 'scheduledQuantity', 'deliveryStatus', 'createdBy'],
    '9': ['routeName', 'driverIdAssigned', 'vehicleIdAssigned', 'startLocation', 'endLocation', 'estimatedDuration', 'totalDistance', 'maxCapacity', 'deliveryDays', 'startTime', 'isActive', 'createdBy'],
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
      return createResponse(401, { error: 'Unauthorized: ' + (error as Error).message });
    }

    const path = event.path || event.rawPath || '';
    const method = event.httpMethod || event.requestContext?.http?.method || '';
    const pathSegments = path.split('/').filter(Boolean);

    // Handle /resources endpoint
    if (path === '/resources' && method === 'GET') {
      if (!hasPermission(user, 'resources', 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const resources = Object.entries(TABLE_CONFIGS).map(([index, config]) => ({
        index,
        name: config.name,
        displayName: config.displayName,
        primaryKey: config.pk
      }));

      return createResponse(200, { resources });
    }

    // Handle table-specific endpoints
    if (pathSegments.length >= 2 && pathSegments[0] === 'api') {
      const tableIndex = pathSegments[1];
      const tableConfig = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
      
      if (!tableConfig) {
        return createResponse(404, { error: 'Table not found' });
      }

      const resourceName = tableConfig.name;
      const primaryKey = tableConfig.pk;

      // Handle bulk import endpoint
      if (pathSegments.length === 3 && pathSegments[2] === 'bulk' && method === 'POST') {
        if (!hasPermission(user, resourceName, 'bulk')) {
          return createResponse(403, { error: 'Insufficient permissions for bulk operations' });
        }

        const body = JSON.parse(event.body || '{}');
        const items = body.items || [];
        
        if (!Array.isArray(items)) {
          return createResponse(400, { error: 'Items must be an array' });
        }

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

            const processedItem = {
              ...item,
              [primaryKey]: item[primaryKey] || randomUUID(),
              pk: `${resourceName.toUpperCase()}#${item[primaryKey] || randomUUID()}`,
              sk: 'ITEM'
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
              errors.push(`Batch write failed: ${(error as Error).message}`);
            }
          }
        }

        await createAuditLog(user, 'BULK_IMPORT', resourceName, { imported, failed, totalItems: items.length });

        return createResponse(200, { imported, failed, errors });
      }

      // Handle individual item operations
      if (method === 'GET' && pathSegments.length === 2) {
        // List all items
        if (!hasPermission(user, resourceName, 'read')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        const result = await docClient.send(new ScanCommand({
          TableName: TABLE_NAME,
          FilterExpression: 'begins_with(pk, :pkPrefix)',
          ExpressionAttributeValues: {
            ':pkPrefix': `${resourceName.toUpperCase()}#`
          }
        }));

        return createResponse(200, { items: result.Items || [] });
      }

      if (method === 'GET' && pathSegments.length === 3) {
        // Get specific item
        if (!hasPermission(user, resourceName, 'read')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        const itemId = pathSegments[2];
        const result = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: `${resourceName.toUpperCase()}#${itemId}`,
            sk: 'ITEM'
          }
        }));

        if (!result.Item) {
          return createResponse(404, { error: 'Item not found' });
        }

        return createResponse(200, result.Item);
      }

      if (method === 'POST' && pathSegments.length === 2) {
        // Create new item
        if (!hasPermission(user, resourceName, 'create')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        const body = JSON.parse(event.body || '{}');
        const requiredFields = getRequiredFieldsByTableIndex(tableIndex);
        const validationErrors = validateRequiredFields(body, requiredFields);
        
        if (validationErrors.length > 0) {
          return createResponse(400, { error: 'Validation failed', details: validationErrors });
        }

        const itemId = body[primaryKey] || randomUUID();
        const item = {
          ...body,
          [primaryKey]: itemId,
          pk: `${resourceName.toUpperCase()}#${itemId}`,
          sk: 'ITEM'
        };
        addTimestamps(item);

        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: item
        }));

        await createAuditLog(user, 'CREATE', resourceName, { itemId });

        return createResponse(201, item);
      }

      if (method === 'PUT' && pathSegments.length === 3) {
        // Update item
        if (!hasPermission(user, resourceName, 'update')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        const itemId = pathSegments[2];
        const body = JSON.parse(event.body || '{}');
        
        // Check if item exists
        const existingItem = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: `${resourceName.toUpperCase()}#${itemId}`,
            sk: 'ITEM'
          }
        }));

        if (!existingItem.Item) {
          return createResponse(404, { error: 'Item not found' });
        }

        const updatedItem = {
          ...existingItem.Item,
          ...body,
          [primaryKey]: itemId,
          pk: `${resourceName.toUpperCase()}#${itemId}`,
          sk: 'ITEM'
        };
        addTimestamps(updatedItem, true);

        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: updatedItem
        }));

        await createAuditLog(user, 'UPDATE', resourceName, { itemId });

        return createResponse(200, updatedItem);
      }

      if (method === 'DELETE' && pathSegments.length === 3) {
        // Delete item
        if (!hasPermission(user, resourceName, 'delete')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        const itemId = pathSegments[2];
        
        // Check if item exists
        const existingItem = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: `${resourceName.toUpperCase()}#${itemId}`,
            sk: 'ITEM'
          }
        }));

        if (!existingItem.Item) {
          return createResponse(404, { error: 'Item not found' });
        }

        await docClient.send(new DeleteCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: `${resourceName.toUpperCase()}#${itemId}`,
            sk: 'ITEM'
          }
        }));

        await createAuditLog(user, 'DELETE', resourceName, { itemId });

        return createResponse(200, { message: 'Item deleted successfully' });
      }
    }

    return createResponse(404, { error: 'Endpoint not found' });

  } catch (error) {
    console.error('Handler error:', error);
    return createResponse(500, { 
      error: 'Internal server error',
      message: (error as Error).message 
    });
  }
};