import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { hasPermission, extractUserFromEvent, User } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

const TABLE_CONFIGS = {
  '0': { name: 'stores', pk: 'storeId', entityType: 'STORE' },
  '1': { name: 'keep_bottles', pk: 'keepBottleId', entityType: 'KEEP_BOTTLE' },
  '2': { name: 'visit_history', pk: 'visitHistoryId', entityType: 'VISIT_HISTORY' },
  '3': { name: 'consumption_history', pk: 'consumptionHistoryId', entityType: 'CONSUMPTION_HISTORY' },
  '4': { name: 'demand_forecast', pk: 'forecastReportId', entityType: 'DEMAND_FORECAST' },
  '5': { name: 'monthly_summary', pk: 'summaryId', entityType: 'MONTHLY_SUMMARY' },
  '6': { name: 'seasonal_analysis', pk: 'seasonalAnalysisId', entityType: 'SEASONAL_ANALYSIS' },
  '7': { name: 'replenishment_plan', pk: 'replenishmentPlanId', entityType: 'REPLENISHMENT_PLAN' },
  '8': { name: 'delivery_schedule', pk: 'deliveryScheduleId', entityType: 'DELIVERY_SCHEDULE' },
  '9': { name: 'delivery_route', pk: 'deliveryRouteId', entityType: 'DELIVERY_ROUTE' },
  '10': { name: 'system_users', pk: 'userId', entityType: 'SYSTEM_USER' }
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

function validateRequiredFields(item: any, requiredFields: string[]): string[] {
  const errors: string[] = [];
  for (const field of requiredFields) {
    if (!item[field]) {
      errors.push(`${field} is required`);
    }
  }
  return errors;
}

function getRequiredFields(tableIndex: string): string[] {
  const fieldMap: { [key: string]: string[] } = {
    '0': ['storeCode', 'storeName', 'storeCategory', 'prefecture', 'city', 'transactionStartDate', 'transactionStatus', 'validFlag', 'creatorId', 'updaterId'],
    '1': ['storeId', 'customerName', 'productName', 'category', 'capacityMl', 'remainingMl', 'remainingPercent', 'keepStartDate', 'status', 'creator'],
    '2': ['memberId', 'storeId', 'visitDateTime', 'keepBottleUsedFlag', 'newBottleOrderFlag', 'creator'],
    '3': ['storeId', 'keepBottleId', 'memberId', 'consumptionDateTime', 'consumptionAmount', 'remainingAmount', 'completedFlag', 'creator'],
    '4': ['storeId', 'productCategory', 'forecastPeriodStart', 'forecastPeriodEnd', 'forecastDemand', 'confidenceLevel', 'seasonalFlag', 'eventFlag', 'recommendedPurchase', 'creator'],
    '5': ['storeId', 'summaryMonth', 'productCategory', 'newKeepBottles', 'completedBottles', 'totalConsumption', 'visitCount', 'activeMemberCount', 'averageConsumption', 'creator'],
    '6': ['analysisYear', 'analysisMonth', 'alcoholCategory', 'regionCode', 'baseConsumption', 'actualConsumption', 'seasonalIndex', 'eventInfluenceFlag', 'creator'],
    '7': ['storeId', 'productCode', 'productName', 'planPeriodStart', 'planPeriodEnd', 'currentStock', 'forecastDemand', 'safetyStock', 'plannedReplenishment', 'scheduledDate', 'planStatus', 'priority', 'creator'],
    '8': ['storeId', 'productCode', 'productName', 'scheduledDeliveryDate', 'scheduledQuantity', 'deliveryStatus', 'creator'],
    '9': ['routeName', 'driverUserId', 'vehicleId', 'startLocation', 'endLocation', 'estimatedDuration', 'totalDistance', 'maxCapacity', 'deliveryDays', 'startTime', 'validFlag', 'creator'],
    '10': ['loginId', 'passwordHash', 'userName', 'email', 'permissionLevel', 'organization', 'accountStatus', 'creator']
  };
  return fieldMap[tableIndex] || [];
}

async function handleGetResources(event: APIGatewayEvent, user: User): Promise<APIGatewayResponse> {
  if (!hasPermission(user, 'resources', 'read')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  try {
    const tableIndex = event.pathParameters?.tableIndex;
    if (!tableIndex || !TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS]) {
      return createResponse(400, { error: 'Invalid table index' });
    }

    const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    const id = event.pathParameters?.id;

    if (id) {
      const result = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: `${config.entityType}#${id}`,
          sk: config.entityType
        }
      }));

      if (!result.Item) {
        return createResponse(404, { error: 'Resource not found' });
      }

      return createResponse(200, result.Item);
    } else {
      const limit = event.queryStringParameters?.limit ? parseInt(event.queryStringParameters.limit) : 50;
      const lastEvaluatedKey = event.queryStringParameters?.lastEvaluatedKey;

      const scanParams: any = {
        TableName: TABLE_NAME,
        FilterExpression: 'begins_with(pk, :entityType)',
        ExpressionAttributeValues: {
          ':entityType': `${config.entityType}#`
        },
        Limit: Math.min(limit, 100)
      };

      if (lastEvaluatedKey) {
        try {
          scanParams.ExclusiveStartKey = JSON.parse(decodeURIComponent(lastEvaluatedKey));
        } catch (e) {
          return createResponse(400, { error: 'Invalid lastEvaluatedKey' });
        }
      }

      const result = await docClient.send(new ScanCommand(scanParams));

      return createResponse(200, {
        items: result.Items || [],
        count: result.Count || 0,
        lastEvaluatedKey: result.LastEvaluatedKey ? encodeURIComponent(JSON.stringify(result.LastEvaluatedKey)) : null
      });
    }
  } catch (error) {
    console.error('Error in handleGetResources:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleCreateResource(event: APIGatewayEvent, user: User): Promise<APIGatewayResponse> {
  if (!hasPermission(user, 'resources', 'create')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  try {
    const tableIndex = event.pathParameters?.tableIndex;
    if (!tableIndex || !TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS]) {
      return createResponse(400, { error: 'Invalid table index' });
    }

    if (!event.body) {
      return createResponse(400, { error: 'Request body is required' });
    }

    const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    const requestBody = JSON.parse(event.body);
    
    const requiredFields = getRequiredFields(tableIndex);
    const validationErrors = validateRequiredFields(requestBody, requiredFields);
    if (validationErrors.length > 0) {
      return createResponse(400, { error: 'Validation failed', details: validationErrors });
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    
    const item = {
      ...requestBody,
      [config.pk]: id,
      pk: `${config.entityType}#${id}`,
      sk: config.entityType,
      createdAt: now,
      updatedAt: now,
      creatorId: user.id,
      updaterId: user.id
    };

    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: item
    }));

    await createAuditLog(user, 'CREATE', config.name, { id, data: requestBody });

    return createResponse(201, { id, message: 'Resource created successfully' });
  } catch (error) {
    console.error('Error in handleCreateResource:', error);
    if (error instanceof SyntaxError) {
      return createResponse(400, { error: 'Invalid JSON in request body' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleUpdateResource(event: APIGatewayEvent, user: User): Promise<APIGatewayResponse> {
  if (!hasPermission(user, 'resources', 'update')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  try {
    const tableIndex = event.pathParameters?.tableIndex;
    const id = event.pathParameters?.id;
    
    if (!tableIndex || !TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS] || !id) {
      return createResponse(400, { error: 'Invalid table index or missing ID' });
    }

    if (!event.body) {
      return createResponse(400, { error: 'Request body is required' });
    }

    const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    const requestBody = JSON.parse(event.body);

    const existingItem = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: `${config.entityType}#${id}`,
        sk: config.entityType
      }
    }));

    if (!existingItem.Item) {
      return createResponse(404, { error: 'Resource not found' });
    }

    const now = new Date().toISOString();
    const updatedItem = {
      ...existingItem.Item,
      ...requestBody,
      updatedAt: now,
      updaterId: user.id
    };

    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: updatedItem
    }));

    await createAuditLog(user, 'UPDATE', config.name, { id, data: requestBody });

    return createResponse(200, { message: 'Resource updated successfully' });
  } catch (error) {
    console.error('Error in handleUpdateResource:', error);
    if (error instanceof SyntaxError) {
      return createResponse(400, { error: 'Invalid JSON in request body' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleDeleteResource(event: APIGatewayEvent, user: User): Promise<APIGatewayResponse> {
  if (!hasPermission(user, 'resources', 'delete')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  try {
    const tableIndex = event.pathParameters?.tableIndex;
    const id = event.pathParameters?.id;
    
    if (!tableIndex || !TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS] || !id) {
      return createResponse(400, { error: 'Invalid table index or missing ID' });
    }

    const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];

    const existingItem = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: `${config.entityType}#${id}`,
        sk: config.entityType
      }
    }));

    if (!existingItem.Item) {
      return createResponse(404, { error: 'Resource not found' });
    }

    await docClient.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: `${config.entityType}#${id}`,
        sk: config.entityType
      }
    }));

    await createAuditLog(user, 'DELETE', config.name, { id });

    return createResponse(200, { message: 'Resource deleted successfully' });
  } catch (error) {
    console.error('Error in handleDeleteResource:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleBulkImport(event: APIGatewayEvent, user: User): Promise<APIGatewayResponse> {
  if (!hasPermission(user, 'resources', 'bulk')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  try {
    const tableIndex = event.pathParameters?.tableIndex;
    if (!tableIndex || !TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS]) {
      return createResponse(400, { error: 'Invalid table index' });
    }

    if (!event.body) {
      return createResponse(400, { error: 'Request body is required' });
    }

    const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    const requestBody = JSON.parse(event.body);
    
    if (!requestBody.items || !Array.isArray(requestBody.items)) {
      return createResponse(400, { error: 'items array is required' });
    }

    const items = requestBody.items;
    let imported = 0;
    let failed = 0;
    const errors: string[] = [];
    const now = new Date().toISOString();

    // Process items in batches of 25 (DynamoDB BatchWrite limit)
    for (let i = 0; i < items.length; i += 25) {
      const batch = items.slice(i, i + 25);
      const writeRequests = [];

      for (const item of batch) {
        try {
          const requiredFields = getRequiredFields(tableIndex);
          const validationErrors = validateRequiredFields(item, requiredFields);
          if (validationErrors.length > 0) {
            failed++;
            errors.push(`Item ${i + batch.indexOf(item)}: ${validationErrors.join(', ')}`);
            continue;
          }

          const id = item[config.pk] || randomUUID();
          const processedItem = {
            ...item,
            [config.pk]: id,
            pk: `${config.entityType}#${id}`,
            sk: config.entityType,
            createdAt: now,
            updatedAt: now,
            creatorId: user.id,
            updaterId: user.id
          };

          writeRequests.push({
            PutRequest: {
              Item: processedItem
            }
          });
        } catch (error) {
          failed++;
          errors.push(`Item ${i + batch.indexOf(item)}: ${error}`);
        }
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

    await createAuditLog(user, 'BULK_IMPORT', config.name, { 
      totalItems: items.length, 
      imported, 
      failed 
    });

    return createResponse(200, {
      imported,
      failed,
      errors
    });
  } catch (error) {
    console.error('Error in handleBulkImport:', error);
    if (error instanceof SyntaxError) {
      return createResponse(400, { error: 'Invalid JSON in request body' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

export const handler = async (event: APIGatewayEvent): Promise<APIGatewayResponse> => {
  if (event.httpMethod === 'OPTIONS') {
    return createResponse(200, {});
  }

  try {
    const user = extractUserFromEvent(event);
    
    const path = event.pathParameters?.proxy || '';
    const pathParts = path.split('/');
    
    if (pathParts[0] === 'resources') {
      return await handleGetResources(event, user);
    }
    
    if (pathParts[0] === 'api' && pathParts[1] && pathParts[2] === 'bulk' && event.httpMethod === 'POST') {
      event.pathParameters = { ...event.pathParameters, tableIndex: pathParts[1] };
      return await handleBulkImport(event, user);
    }
    
    if (pathParts[0] === 'api' && pathParts[1]) {
      event.pathParameters = { 
        ...event.pathParameters, 
        tableIndex: pathParts[1],
        id: pathParts[2] || null
      };
      
      switch (event.httpMethod) {
        case 'GET':
          return await handleGetResources(event, user);
        case 'POST':
          return await handleCreateResource(event, user);
        case 'PUT':
          return await handleUpdateResource(event, user);
        case 'DELETE':
          return await handleDeleteResource(event, user);
        default:
          return createResponse(405, { error: 'Method not allowed' });
      }
    }
    
    return createResponse(404, { error: 'Endpoint not found' });
  } catch (error) {
    console.error('Handler error:', error);
    if (error instanceof Error && error.message.includes('Authorization')) {
      return createResponse(401, { error: 'Unauthorized' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
};