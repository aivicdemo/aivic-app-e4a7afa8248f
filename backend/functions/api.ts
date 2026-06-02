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
  '3': { name: 'keepBottleConsumptionHistory', pk: 'consumptionHistoryId', entityType: 'CONSUMPTION_HISTORY' },
  '4': { name: 'demandForecastReports', pk: 'forecastReportId', entityType: 'FORECAST_REPORT' },
  '5': { name: 'monthlyAggregateData', pk: 'aggregateId', entityType: 'MONTHLY_AGGREGATE' },
  '6': { name: 'seasonalVariationAnalysis', pk: 'seasonalVariationAnalysisId', entityType: 'SEASONAL_VARIATION' },
  '7': { name: 'replenishmentPlans', pk: 'replenishmentPlanId', entityType: 'REPLENISHMENT_PLAN' },
  '8': { name: 'deliverySchedules', pk: 'deliveryScheduleId', entityType: 'DELIVERY_SCHEDULE' },
  '9': { name: 'deliveryRoutes', pk: 'deliveryRouteId', entityType: 'DELIVERY_ROUTE' },
  '10': { name: 'systemUsers', pk: 'userId', entityType: 'SYSTEM_USER' }
};

interface APIGatewayEvent {
  httpMethod: string;
  path: string;
  pathParameters?: { [key: string]: string };
  queryStringParameters?: { [key: string]: string };
  body?: string;
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
    if (item[field] === undefined || item[field] === null || item[field] === '') {
      errors.push(`${field} is required`);
    }
  }
  return errors;
}

function getRequiredFieldsByEntityType(entityType: string): string[] {
  const fieldMap: { [key: string]: string[] } = {
    'STORE': ['storeCode', 'storeName', 'storeCategory', 'prefecture', 'city', 'transactionStartDate', 'transactionStatus', 'validFlag', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy'],
    'KEEP_BOTTLE': ['storeId', 'customerName', 'productName', 'category', 'capacityMl', 'remainingMl', 'remainingPercent', 'keepStartDate', 'status', 'createdAt', 'updatedAt', 'createdBy'],
    'VISIT_HISTORY': ['memberId', 'storeId', 'visitDateTime', 'keepBottleUsedFlag', 'newBottleOrderFlag', 'createdAt', 'updatedAt', 'createdBy'],
    'CONSUMPTION_HISTORY': ['storeId', 'keepBottleId', 'memberId', 'consumptionDateTime', 'consumptionAmount', 'remainingAmount', 'completedFlag', 'createdAt', 'createdBy'],
    'FORECAST_REPORT': ['storeId', 'productCategory', 'forecastPeriodStart', 'forecastPeriodEnd', 'forecastDemand', 'confidenceLevel', 'seasonalFactorFlag', 'eventFactorFlag', 'recommendedPurchaseAmount', 'createdAt', 'updatedAt', 'createdBy'],
    'MONTHLY_AGGREGATE': ['storeId', 'aggregateYearMonth', 'productCategory', 'newKeepBottles', 'completedBottles', 'totalConsumption', 'totalVisitors', 'activeMembers', 'averageConsumption', 'createdAt', 'updatedAt', 'createdBy'],
    'SEASONAL_VARIATION': ['analysisYear', 'analysisMonth', 'alcoholCategory', 'regionCode', 'baseConsumption', 'actualConsumption', 'seasonalVariationIndex', 'eventInfluenceFlag', 'temperatureInfluence', 'createdAt', 'updatedAt', 'createdBy'],
    'REPLENISHMENT_PLAN': ['storeId', 'productCode', 'productName', 'planPeriodStart', 'planPeriodEnd', 'currentStock', 'forecastDemand', 'safetyStock', 'plannedReplenishment', 'scheduledReplenishmentDate', 'planStatus', 'priority', 'createdAt', 'updatedAt', 'createdBy'],
    'DELIVERY_SCHEDULE': ['storeId', 'productCode', 'productName', 'scheduledDeliveryDate', 'scheduledQuantity', 'deliveryStatus', 'createdAt', 'updatedAt', 'createdBy'],
    'DELIVERY_ROUTE': ['routeName', 'driverId', 'vehicleId', 'startLocation', 'endLocation', 'estimatedDuration', 'totalDistance', 'maxCapacity', 'deliveryDays', 'startTime', 'validFlag', 'createdAt', 'updatedAt', 'createdBy'],
    'SYSTEM_USER': ['loginId', 'passwordHash', 'userName', 'email', 'permissionLevel', 'organization', 'accountStatus', 'createdAt', 'updatedAt', 'createdBy']
  };
  return fieldMap[entityType] || [];
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

    const path = event.path;
    const method = event.httpMethod;
    const pathParts = path.split('/').filter(p => p);

    if (pathParts[0] === 'resources') {
      if (method === 'GET') {
        if (!hasPermission(user, 'resources', 'read')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        try {
          const result = await docClient.send(new ScanCommand({
            TableName: TABLE_NAME,
            FilterExpression: 'attribute_exists(pk) AND pk <> :auditPk',
            ExpressionAttributeValues: {
              ':auditPk': 'AUDIT'
            }
          }));

          return createResponse(200, {
            items: result.Items || [],
            count: result.Count || 0
          });
        } catch (error) {
          console.error('Error scanning resources:', error);
          return createResponse(500, { error: 'Internal server error' });
        }
      }
    }

    if (pathParts[0] === 'api' && pathParts.length >= 2) {
      const tableIndex = pathParts[1];
      const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
      
      if (!config) {
        return createResponse(404, { error: 'Table not found' });
      }

      if (pathParts[2] === 'bulk' && method === 'POST') {
        if (!hasPermission(user, config.name, 'bulk')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        try {
          const body = JSON.parse(event.body || '{}');
          const items = body.items || [];
          
          if (!Array.isArray(items)) {
            return createResponse(400, { error: 'Items must be an array' });
          }

          let imported = 0;
          let failed = 0;
          const errors: string[] = [];
          const requiredFields = getRequiredFieldsByEntityType(config.entityType);

          const chunks = [];
          for (let i = 0; i < items.length; i += 25) {
            chunks.push(items.slice(i, i + 25));
          }

          for (const chunk of chunks) {
            const writeRequests = [];
            
            for (const item of chunk) {
              const validationErrors = validateRequiredFields(item, requiredFields.filter(f => !['createdAt', 'updatedAt', 'createdBy', 'updatedBy'].includes(f)));
              if (validationErrors.length > 0) {
                failed++;
                errors.push(`Validation failed: ${validationErrors.join(', ')}`);
                continue;
              }

              const now = new Date().toISOString();
              const enrichedItem = {
                ...item,
                [config.pk]: item[config.pk] || randomUUID(),
                pk: `${config.entityType}#${item[config.pk] || randomUUID()}`,
                sk: item.sk || 'MAIN',
                entityType: config.entityType,
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

          await createAuditLog(user, 'BULK_IMPORT', config.name, {
            tableIndex,
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
          console.error('Bulk import error:', error);
          return createResponse(500, { error: 'Internal server error' });
        }
      }

      if (method === 'GET' && pathParts.length === 2) {
        if (!hasPermission(user, config.name, 'read')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        try {
          const result = await docClient.send(new ScanCommand({
            TableName: TABLE_NAME,
            FilterExpression: 'entityType = :entityType',
            ExpressionAttributeValues: {
              ':entityType': config.entityType
            }
          }));

          return createResponse(200, {
            items: result.Items || [],
            count: result.Count || 0
          });
        } catch (error) {
          console.error('Error scanning table:', error);
          return createResponse(500, { error: 'Internal server error' });
        }
      }

      if (method === 'GET' && pathParts.length === 3) {
        if (!hasPermission(user, config.name, 'read')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        const id = pathParts[2];
        try {
          const result = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: `${config.entityType}#${id}`,
              sk: 'MAIN'
            }
          }));

          if (!result.Item) {
            return createResponse(404, { error: 'Item not found' });
          }

          return createResponse(200, result.Item);
        } catch (error) {
          console.error('Error getting item:', error);
          return createResponse(500, { error: 'Internal server error' });
        }
      }

      if (method === 'POST' && pathParts.length === 2) {
        if (!hasPermission(user, config.name, 'create')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        try {
          const body = JSON.parse(event.body || '{}');
          const requiredFields = getRequiredFieldsByEntityType(config.entityType);
          const validationErrors = validateRequiredFields(body, requiredFields.filter(f => !['createdAt', 'updatedAt', 'createdBy', 'updatedBy'].includes(f)));
          
          if (validationErrors.length > 0) {
            return createResponse(400, { error: 'Validation failed', details: validationErrors });
          }

          const id = body[config.pk] || randomUUID();
          const now = new Date().toISOString();
          
          const item = {
            ...body,
            [config.pk]: id,
            pk: `${config.entityType}#${id}`,
            sk: 'MAIN',
            entityType: config.entityType,
            createdAt: now,
            updatedAt: now,
            createdBy: user.id,
            updatedBy: user.id
          };

          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: item
          }));

          await createAuditLog(user, 'CREATE', config.name, { id, item });

          return createResponse(201, item);
        } catch (error) {
          console.error('Error creating item:', error);
          return createResponse(500, { error: 'Internal server error' });
        }
      }

      if (method === 'PUT' && pathParts.length === 3) {
        if (!hasPermission(user, config.name, 'update')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        const id = pathParts[2];
        try {
          const body = JSON.parse(event.body || '{}');
          const now = new Date().toISOString();
          
          const item = {
            ...body,
            [config.pk]: id,
            pk: `${config.entityType}#${id}`,
            sk: 'MAIN',
            entityType: config.entityType,
            updatedAt: now,
            updatedBy: user.id
          };

          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: item
          }));

          await createAuditLog(user, 'UPDATE', config.name, { id, item });

          return createResponse(200, item);
        } catch (error) {
          console.error('Error updating item:', error);
          return createResponse(500, { error: 'Internal server error' });
        }
      }

      if (method === 'DELETE' && pathParts.length === 3) {
        if (!hasPermission(user, config.name, 'delete')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        const id = pathParts[2];
        try {
          await docClient.send(new DeleteCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: `${config.entityType}#${id}`,
              sk: 'MAIN'
            }
          }));

          await createAuditLog(user, 'DELETE', config.name, { id });

          return createResponse(200, { message: 'Item deleted successfully' });
        } catch (error) {
          console.error('Error deleting item:', error);
          return createResponse(500, { error: 'Internal server error' });
        }
      }
    }

    return createResponse(404, { error: 'Endpoint not found' });
  } catch (error) {
    console.error('Unhandled error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};