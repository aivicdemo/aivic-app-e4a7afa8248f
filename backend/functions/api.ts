import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { hasPermission, extractUserFromEvent, User } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

const TABLE_CONFIGS = {
  '0': { name: 'stores', pk: 'storeId', entityType: 'STORE' },
  '1': { name: 'keepBottleInventory', pk: 'keepBottleId', entityType: 'KEEP_BOTTLE' },
  '2': { name: 'memberVisitHistory', pk: 'visitHistoryId', entityType: 'VISIT_HISTORY' },
  '3': { name: 'keepBottleConsumption', pk: 'consumptionHistoryId', entityType: 'CONSUMPTION_HISTORY' },
  '4': { name: 'demandForecastReports', pk: 'forecastReportId', entityType: 'DEMAND_FORECAST' },
  '5': { name: 'monthlyAggregateData', pk: 'aggregateId', entityType: 'MONTHLY_AGGREGATE' },
  '6': { name: 'seasonalVariationAnalysis', pk: 'seasonalVariationAnalysisId', entityType: 'SEASONAL_ANALYSIS' },
  '7': { name: 'replenishmentPlans', pk: 'replenishmentPlanId', entityType: 'REPLENISHMENT_PLAN' },
  '8': { name: 'deliverySchedules', pk: 'deliveryScheduleId', entityType: 'DELIVERY_SCHEDULE' },
  '9': { name: 'deliveryRoutes', pk: 'deliveryRouteId', entityType: 'DELIVERY_ROUTE' },
  '10': { name: 'systemUsers', pk: 'userId', entityType: 'SYSTEM_USER' }
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

function getRequiredFieldsByEntityType(entityType: string): string[] {
  const fieldMap: { [key: string]: string[] } = {
    'STORE': ['storeCode', 'storeName', 'storeCategory', 'prefecture', 'city', 'transactionStartDate', 'transactionStatus', 'validFlag', 'createdBy', 'updatedBy'],
    'KEEP_BOTTLE': ['storeId', 'customerName', 'productName', 'category', 'capacityMl', 'remainingMl', 'remainingPercent', 'keepStartDate', 'status', 'createdBy'],
    'VISIT_HISTORY': ['memberId', 'storeId', 'visitDateTime', 'keepBottleUsedFlag', 'newBottleOrderFlag', 'createdBy'],
    'CONSUMPTION_HISTORY': ['storeId', 'keepBottleId', 'memberId', 'consumptionDateTime', 'consumptionAmount', 'remainingAmount', 'completedFlag', 'createdBy'],
    'DEMAND_FORECAST': ['storeId', 'productCategory', 'forecastPeriodStart', 'forecastPeriodEnd', 'forecastDemand', 'confidenceLevel', 'seasonalFactorFlag', 'eventFactorFlag', 'recommendedPurchaseAmount', 'createdBy'],
    'MONTHLY_AGGREGATE': ['storeId', 'aggregateYearMonth', 'productCategory', 'newKeepBottles', 'completedBottles', 'totalConsumption', 'visitCount', 'activeMemberCount', 'averageConsumption', 'createdBy'],
    'SEASONAL_ANALYSIS': ['analysisYear', 'analysisMonth', 'alcoholCategory', 'regionCode', 'baseConsumption', 'actualConsumption', 'seasonalIndex', 'eventInfluenceFlag', 'createdBy'],
    'REPLENISHMENT_PLAN': ['storeId', 'productCode', 'productName', 'planPeriodStart', 'planPeriodEnd', 'currentStock', 'forecastDemand', 'safetyStock', 'plannedReplenishment', 'scheduledDate', 'planStatus', 'priority', 'createdBy'],
    'DELIVERY_SCHEDULE': ['storeId', 'productCode', 'productName', 'scheduledDeliveryDate', 'scheduledQuantity', 'deliveryStatus', 'createdBy'],
    'DELIVERY_ROUTE': ['routeName', 'driverId', 'vehicleId', 'startLocation', 'endLocation', 'estimatedDuration', 'totalDistance', 'maxCapacity', 'deliveryDays', 'startTime', 'validFlag', 'createdBy'],
    'SYSTEM_USER': ['loginId', 'passwordHash', 'userName', 'email', 'permissionLevel', 'organization', 'accountStatus', 'createdBy']
  };
  return fieldMap[entityType] || [];
}

export const handler = async (event: APIGatewayEvent): Promise<APIGatewayResponse> => {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return createResponse(200, {});
    }

    const user = extractUserFromEvent(event);
    const path = event.pathParameters?.proxy || '';
    const pathParts = path.split('/');
    
    if (pathParts[0] === 'resources') {
      if (!hasPermission(user, 'resources', 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }
      
      const resources = Object.entries(TABLE_CONFIGS).map(([index, config]) => ({
        index,
        name: config.name,
        entityType: config.entityType
      }));
      
      return createResponse(200, { resources });
    }
    
    const tableIndex = pathParts[0];
    const tableConfig = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    
    if (!tableConfig) {
      return createResponse(404, { error: 'Table not found' });
    }

    const isBulkOperation = pathParts[1] === 'bulk';
    const itemId = pathParts[1] && !isBulkOperation ? pathParts[1] : null;
    
    if (isBulkOperation && event.httpMethod === 'POST') {
      if (!hasPermission(user, tableConfig.name, 'bulk')) {
        return createResponse(403, { error: 'Insufficient permissions for bulk operations' });
      }
      
      const body = JSON.parse(event.body || '{}');
      const items = body.items || [];
      
      if (!Array.isArray(items)) {
        return createResponse(400, { error: 'Items must be an array' });
      }
      
      const requiredFields = getRequiredFieldsByEntityType(tableConfig.entityType);
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
          
          const now = new Date().toISOString();
          const processedItem = {
            ...item,
            [tableConfig.pk]: item[tableConfig.pk] || randomUUID(),
            pk: tableConfig.entityType,
            sk: item[tableConfig.pk] || randomUUID(),
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
      
      await createAuditLog(user, 'BULK_IMPORT', tableConfig.name, { imported, failed, totalItems: items.length });
      
      return createResponse(200, { imported, failed, errors });
    }
    
    switch (event.httpMethod) {
      case 'GET':
        if (!hasPermission(user, tableConfig.name, 'read')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }
        
        if (itemId) {
          const result = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: tableConfig.entityType,
              sk: itemId
            }
          }));
          
          if (!result.Item) {
            return createResponse(404, { error: 'Item not found' });
          }
          
          return createResponse(200, result.Item);
        } else {
          const limit = event.queryStringParameters?.limit ? parseInt(event.queryStringParameters.limit) : 50;
          const result = await docClient.send(new ScanCommand({
            TableName: TABLE_NAME,
            FilterExpression: 'pk = :pk',
            ExpressionAttributeValues: {
              ':pk': tableConfig.entityType
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
          return createResponse(403, { error: 'Insufficient permissions' });
        }
        
        const createBody = JSON.parse(event.body || '{}');
        const requiredFields = getRequiredFieldsByEntityType(tableConfig.entityType);
        const validationErrors = validateRequiredFields(createBody, requiredFields);
        
        if (validationErrors.length > 0) {
          return createResponse(400, { error: 'Validation failed', details: validationErrors });
        }
        
        const newId = randomUUID();
        const now = new Date().toISOString();
        const newItem = {
          ...createBody,
          [tableConfig.pk]: newId,
          pk: tableConfig.entityType,
          sk: newId,
          createdAt: now,
          updatedAt: now
        };
        
        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: newItem
        }));
        
        await createAuditLog(user, 'CREATE', tableConfig.name, { id: newId });
        
        return createResponse(201, newItem);
        
      case 'PUT':
        if (!itemId) {
          return createResponse(400, { error: 'Item ID is required for updates' });
        }
        
        if (!hasPermission(user, tableConfig.name, 'update')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }
        
        const updateBody = JSON.parse(event.body || '{}');
        const updateRequiredFields = getRequiredFieldsByEntityType(tableConfig.entityType);
        const updateValidationErrors = validateRequiredFields(updateBody, updateRequiredFields);
        
        if (updateValidationErrors.length > 0) {
          return createResponse(400, { error: 'Validation failed', details: updateValidationErrors });
        }
        
        const existingItem = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: tableConfig.entityType,
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
          pk: tableConfig.entityType,
          sk: itemId,
          updatedAt: new Date().toISOString()
        };
        
        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: updatedItem
        }));
        
        await createAuditLog(user, 'UPDATE', tableConfig.name, { id: itemId });
        
        return createResponse(200, updatedItem);
        
      case 'DELETE':
        if (!itemId) {
          return createResponse(400, { error: 'Item ID is required for deletion' });
        }
        
        if (!hasPermission(user, tableConfig.name, 'delete')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }
        
        const itemToDelete = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: tableConfig.entityType,
            sk: itemId
          }
        }));
        
        if (!itemToDelete.Item) {
          return createResponse(404, { error: 'Item not found' });
        }
        
        await docClient.send(new DeleteCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: tableConfig.entityType,
            sk: itemId
          }
        }));
        
        await createAuditLog(user, 'DELETE', tableConfig.name, { id: itemId });
        
        return createResponse(200, { message: 'Item deleted successfully' });
        
      default:
        return createResponse(405, { error: 'Method not allowed' });
    }
    
  } catch (error: any) {
    console.error('Error:', error);
    
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return createResponse(401, { error: 'Unauthorized' });
    }
    
    return createResponse(500, { error: 'Internal server error', details: error.message });
  }
};