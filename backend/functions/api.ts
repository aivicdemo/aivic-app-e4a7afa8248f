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
  '10': { name: 'systemUsers', pk: 'userId', displayName: 'システム利用者' }
};

interface APIGatewayEvent {
  httpMethod: string;
  pathParameters?: { [key: string]: string };
  queryStringParameters?: { [key: string]: string };
  body?: string;
  headers?: { [key: string]: string };
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

async function writeAuditLog(user: User, action: string, resource: string, details?: any): Promise<void> {
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
    '4': ['storeId', 'productCategory', 'forecastPeriodStart', 'forecastPeriodEnd', 'forecastDemand', 'confidenceLevel', 'seasonalFactorFlag', 'eventFactorFlag', 'recommendedPurchaseAmount', 'createdBy'],
    '5': ['storeId', 'aggregateYearMonth', 'productCategory', 'newKeepBottles', 'completedBottles', 'totalConsumption', 'visitCount', 'activeMemberCount', 'averageConsumption', 'createdBy'],
    '6': ['analysisYear', 'analysisMonth', 'alcoholCategory', 'regionCode', 'baseConsumption', 'actualConsumption', 'seasonalVariationIndex', 'eventInfluenceFlag', 'createdBy'],
    '7': ['storeId', 'productCode', 'productName', 'planPeriodStart', 'planPeriodEnd', 'currentStock', 'forecastDemand', 'safetyStock', 'plannedReplenishment', 'scheduledReplenishmentDate', 'planStatus', 'priority', 'createdBy'],
    '8': ['storeId', 'productCode', 'productName', 'scheduledDeliveryDate', 'scheduledQuantity', 'deliveryStatus', 'createdBy'],
    '9': ['routeName', 'driverUserId', 'vehicleId', 'startLocation', 'endLocation', 'estimatedDuration', 'totalDistance', 'maxCapacity', 'deliveryDays', 'startTime', 'validFlag', 'createdBy'],
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
      if (event.httpMethod === 'GET') {
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
    }

    if (pathParts[0] === 'api' && pathParts[1] && TABLE_CONFIGS[pathParts[1]]) {
      const tableIndex = pathParts[1];
      const tableConfig = TABLE_CONFIGS[tableIndex];
      const isBulkOperation = pathParts[2] === 'bulk';
      const itemId = pathParts[2] && !isBulkOperation ? pathParts[2] : null;

      if (isBulkOperation && event.httpMethod === 'POST') {
        if (!hasPermission(user, tableConfig.name, 'bulk')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        let requestBody;
        try {
          requestBody = JSON.parse(event.body || '{}');
        } catch {
          return createResponse(400, { error: 'Invalid JSON in request body' });
        }

        const { items } = requestBody;
        if (!Array.isArray(items)) {
          return createResponse(400, { error: 'items must be an array' });
        }

        const requiredFields = getRequiredFieldsByTableIndex(tableIndex);
        let imported = 0;
        let failed = 0;
        const errors: string[] = [];

        // Process in batches of 25 (DynamoDB BatchWrite limit)
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
              [tableConfig.pk]: item[tableConfig.pk] || randomUUID(),
              pk: tableConfig.name,
              sk: item[tableConfig.pk] || randomUUID()
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

        await writeAuditLog(user, 'BULK_IMPORT', tableConfig.displayName, { imported, failed, total: items.length });

        return createResponse(200, { imported, failed, errors });
      }

      switch (event.httpMethod) {
        case 'GET':
          if (!hasPermission(user, tableConfig.name, 'read')) {
            return createResponse(403, { error: 'Forbidden' });
          }

          if (itemId) {
            const result = await docClient.send(new GetCommand({
              TableName: TABLE_NAME,
              Key: {
                pk: tableConfig.name,
                sk: itemId
              }
            }));

            if (!result.Item) {
              return createResponse(404, { error: 'Item not found' });
            }

            return createResponse(200, { item: result.Item });
          } else {
            const limit = event.queryStringParameters?.limit ? parseInt(event.queryStringParameters.limit) : 50;
            const result = await docClient.send(new ScanCommand({
              TableName: TABLE_NAME,
              FilterExpression: 'pk = :pk',
              ExpressionAttributeValues: {
                ':pk': tableConfig.name
              },
              Limit: Math.min(limit, 100)
            }));

            return createResponse(200, {
              items: result.Items || [],
              count: result.Count || 0,
              lastEvaluatedKey: result.LastEvaluatedKey
            });
          }

        case 'POST':
          if (!hasPermission(user, tableConfig.name, 'create')) {
            return createResponse(403, { error: 'Forbidden' });
          }

          let createBody;
          try {
            createBody = JSON.parse(event.body || '{}');
          } catch {
            return createResponse(400, { error: 'Invalid JSON in request body' });
          }

          const createValidationErrors = validateRequiredFields(createBody, getRequiredFieldsByTableIndex(tableIndex));
          if (createValidationErrors.length > 0) {
            return createResponse(400, { error: 'Validation failed', details: createValidationErrors });
          }

          const newId = randomUUID();
          const newItem = {
            ...createBody,
            [tableConfig.pk]: newId,
            pk: tableConfig.name,
            sk: newId
          };
          addTimestamps(newItem);

          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: newItem
          }));

          await writeAuditLog(user, 'CREATE', tableConfig.displayName, { id: newId });

          return createResponse(201, { item: newItem });

        case 'PUT':
          if (!itemId) {
            return createResponse(400, { error: 'Item ID is required for updates' });
          }

          if (!hasPermission(user, tableConfig.name, 'update')) {
            return createResponse(403, { error: 'Forbidden' });
          }

          let updateBody;
          try {
            updateBody = JSON.parse(event.body || '{}');
          } catch {
            return createResponse(400, { error: 'Invalid JSON in request body' });
          }

          const existingItem = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: tableConfig.name,
              sk: itemId
            }
          }));

          if (!existingItem.Item) {
            return createResponse(404, { error: 'Item not found' });
          }

          const updatedItem = {
            ...existingItem.Item,
            ...updateBody,
            [tableConfig.pk]: itemId,
            pk: tableConfig.name,
            sk: itemId
          };
          addTimestamps(updatedItem, true);

          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: updatedItem
          }));

          await writeAuditLog(user, 'UPDATE', tableConfig.displayName, { id: itemId });

          return createResponse(200, { item: updatedItem });

        case 'DELETE':
          if (!itemId) {
            return createResponse(400, { error: 'Item ID is required for deletion' });
          }

          if (!hasPermission(user, tableConfig.name, 'delete')) {
            return createResponse(403, { error: 'Forbidden' });
          }

          const itemToDelete = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: tableConfig.name,
              sk: itemId
            }
          }));

          if (!itemToDelete.Item) {
            return createResponse(404, { error: 'Item not found' });
          }

          await docClient.send(new DeleteCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: tableConfig.name,
              sk: itemId
            }
          }));

          await writeAuditLog(user, 'DELETE', tableConfig.displayName, { id: itemId });

          return createResponse(200, { message: 'Item deleted successfully' });

        default:
          return createResponse(405, { error: 'Method not allowed' });
      }
    }

    return createResponse(404, { error: 'Endpoint not found' });

  } catch (error) {
    console.error('Handler error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};