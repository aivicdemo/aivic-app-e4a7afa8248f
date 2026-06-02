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
  '4': { name: 'demandForecastReports', pk: 'forecastReportId', displayName: '需要予測レポート' },
  '5': { name: 'monthlyAggregateData', pk: 'aggregateId', displayName: '月次集計データ' },
  '6': { name: 'seasonalVariationAnalysis', pk: 'seasonalVariationAnalysisId', displayName: '季節変動分析データ' },
  '7': { name: 'replenishmentPlans', pk: 'replenishmentPlanId', displayName: '補充計画' },
  '8': { name: 'deliverySchedules', pk: 'deliveryScheduleId', displayName: '納品スケジュール' },
  '9': { name: 'deliveryRoutes', pk: 'deliveryRouteId', displayName: '配送ルート' },
  '10': { name: 'systemUsers', pk: 'userId', displayName: 'システム利用者' }
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
  const fieldMap: { [key: string]: string[] } = {
    '0': ['storeCode', 'storeName', 'storeCategory', 'prefecture', 'city', 'transactionStartDate', 'transactionStatus', 'validFlag'],
    '1': ['storeId', 'customerName', 'productName', 'category', 'capacityMl', 'remainingMl', 'remainingPercentage', 'keepStartDate', 'status'],
    '2': ['memberId', 'storeId', 'visitDateTime', 'keepBottleUsedFlag', 'newBottleOrderFlag'],
    '3': ['storeId', 'keepBottleId', 'memberId', 'consumptionDateTime', 'consumptionAmount', 'remainingAmount', 'completedFlag'],
    '4': ['storeId', 'productCategory', 'forecastPeriodStart', 'forecastPeriodEnd', 'forecastDemand', 'confidenceLevel', 'seasonalFactorFlag', 'eventFactorFlag', 'recommendedPurchaseAmount'],
    '5': ['storeId', 'aggregateYearMonth', 'productCategory', 'newKeepBottles', 'completedBottles', 'totalConsumption', 'totalVisitors', 'activeMembers', 'averageConsumption'],
    '6': ['analysisYear', 'analysisMonth', 'alcoholCategory', 'regionCode', 'baseConsumption', 'actualConsumption', 'seasonalVariationIndex', 'eventInfluenceFlag', 'temperatureInfluence'],
    '7': ['storeId', 'productCode', 'productName', 'planPeriodStart', 'planPeriodEnd', 'currentStock', 'forecastDemand', 'safetyStock', 'plannedReplenishment', 'scheduledReplenishmentDate', 'planStatus', 'priority'],
    '8': ['storeId', 'productCode', 'productName', 'scheduledDeliveryDate', 'scheduledQuantity', 'deliveryStatus'],
    '9': ['routeName', 'driverId', 'vehicleId', 'startLocation', 'endLocation', 'estimatedDuration', 'totalDistance', 'maxCapacity', 'deliveryDays', 'startTime', 'validFlag'],
    '10': ['loginId', 'passwordHash', 'userName', 'email', 'permissionLevel', 'organization', 'accountStatus']
  };
  return fieldMap[tableIndex] || [];
}

async function handleBulkImport(event: APIGatewayEvent, user: User, tableIndex: string): Promise<APIGatewayResponse> {
  if (!hasPermission(user, 'bulk', 'bulk')) {
    return createResponse(403, { error: 'Insufficient permissions for bulk import' });
  }

  const tableConfig = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
  if (!tableConfig) {
    return createResponse(404, { error: 'Table not found' });
  }

  let requestBody;
  try {
    requestBody = JSON.parse(event.body || '{}');
  } catch (error) {
    return createResponse(400, { error: 'Invalid JSON in request body' });
  }

  const { items } = requestBody;
  if (!Array.isArray(items)) {
    return createResponse(400, { error: 'items must be an array' });
  }

  const requiredFields = getRequiredFields(tableIndex);
  let imported = 0;
  let failed = 0;
  const errors: string[] = [];

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

      const now = new Date().toISOString();
      const enrichedItem = {
        ...item,
        [tableConfig.pk]: item[tableConfig.pk] || randomUUID(),
        pk: tableConfig.name,
        sk: item[tableConfig.pk] || randomUUID(),
        createdAt: now,
        updatedAt: now,
        createdBy: user.id,
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

  await createAuditLog(user, 'BULK_IMPORT', tableConfig.displayName, {
    totalItems: items.length,
    imported,
    failed
  });

  return createResponse(200, { imported, failed, errors });
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

    if (path === 'resources') {
      if (event.httpMethod === 'GET') {
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
    }

    // Handle table-specific operations
    if (pathParts.length >= 1) {
      const tableIndex = pathParts[0];
      const tableConfig = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
      
      if (!tableConfig) {
        return createResponse(404, { error: 'Table not found' });
      }

      // Bulk import endpoint
      if (pathParts[1] === 'bulk' && event.httpMethod === 'POST') {
        return await handleBulkImport(event, user, tableIndex);
      }

      const resourceId = pathParts[1];

      switch (event.httpMethod) {
        case 'GET':
          if (!hasPermission(user, tableConfig.name, 'read')) {
            return createResponse(403, { error: 'Insufficient permissions' });
          }

          if (resourceId) {
            // Get single item
            const result = await docClient.send(new GetCommand({
              TableName: TABLE_NAME,
              Key: {
                pk: tableConfig.name,
                sk: resourceId
              }
            }));

            if (!result.Item) {
              return createResponse(404, { error: 'Item not found' });
            }

            return createResponse(200, result.Item);
          } else {
            // List items
            const limit = event.queryStringParameters?.limit ? parseInt(event.queryStringParameters.limit) : 50;
            const lastEvaluatedKey = event.queryStringParameters?.lastEvaluatedKey;

            const scanParams: any = {
              TableName: TABLE_NAME,
              FilterExpression: 'pk = :pk',
              ExpressionAttributeValues: {
                ':pk': tableConfig.name
              },
              Limit: Math.min(limit, 100)
            };

            if (lastEvaluatedKey) {
              try {
                scanParams.ExclusiveStartKey = JSON.parse(Buffer.from(lastEvaluatedKey, 'base64').toString());
              } catch (error) {
                return createResponse(400, { error: 'Invalid lastEvaluatedKey' });
              }
            }

            const result = await docClient.send(new ScanCommand(scanParams));

            const response: any = {
              items: result.Items || [],
              count: result.Count || 0
            };

            if (result.LastEvaluatedKey) {
              response.lastEvaluatedKey = Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64');
            }

            return createResponse(200, response);
          }

        case 'POST':
          if (!hasPermission(user, tableConfig.name, 'create')) {
            return createResponse(403, { error: 'Insufficient permissions' });
          }

          let createBody;
          try {
            createBody = JSON.parse(event.body || '{}');
          } catch (error) {
            return createResponse(400, { error: 'Invalid JSON in request body' });
          }

          const requiredFields = getRequiredFields(tableIndex);
          const validationErrors = validateRequired(createBody, requiredFields);
          if (validationErrors.length > 0) {
            return createResponse(400, { error: 'Validation failed', details: validationErrors });
          }

          const newId = randomUUID();
          const now = new Date().toISOString();
          const newItem = {
            ...createBody,
            [tableConfig.pk]: newId,
            pk: tableConfig.name,
            sk: newId,
            createdAt: now,
            updatedAt: now,
            createdBy: user.id,
            updatedBy: user.id
          };

          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: newItem
          }));

          await createAuditLog(user, 'CREATE', tableConfig.displayName, { id: newId });

          return createResponse(201, newItem);

        case 'PUT':
          if (!resourceId) {
            return createResponse(400, { error: 'Resource ID is required for updates' });
          }

          if (!hasPermission(user, tableConfig.name, 'update')) {
            return createResponse(403, { error: 'Insufficient permissions' });
          }

          let updateBody;
          try {
            updateBody = JSON.parse(event.body || '{}');
          } catch (error) {
            return createResponse(400, { error: 'Invalid JSON in request body' });
          }

          // Check if item exists
          const existingItem = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: tableConfig.name,
              sk: resourceId
            }
          }));

          if (!existingItem.Item) {
            return createResponse(404, { error: 'Item not found' });
          }

          const updatedItem = {
            ...existingItem.Item,
            ...updateBody,
            [tableConfig.pk]: resourceId,
            pk: tableConfig.name,
            sk: resourceId,
            updatedAt: new Date().toISOString(),
            updatedBy: user.id
          };

          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: updatedItem
          }));

          await createAuditLog(user, 'UPDATE', tableConfig.displayName, { id: resourceId });

          return createResponse(200, updatedItem);

        case 'DELETE':
          if (!resourceId) {
            return createResponse(400, { error: 'Resource ID is required for deletion' });
          }

          if (!hasPermission(user, tableConfig.name, 'delete')) {
            return createResponse(403, { error: 'Insufficient permissions' });
          }

          // Check if item exists
          const itemToDelete = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: tableConfig.name,
              sk: resourceId
            }
          }));

          if (!itemToDelete.Item) {
            return createResponse(404, { error: 'Item not found' });
          }

          await docClient.send(new DeleteCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: tableConfig.name,
              sk: resourceId
            }
          }));

          await createAuditLog(user, 'DELETE', tableConfig.displayName, { id: resourceId });

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