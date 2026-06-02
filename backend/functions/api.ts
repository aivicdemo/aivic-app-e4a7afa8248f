import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { hasPermission, extractUserFromEvent, User } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

const tableConfigs = {
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

function createResponse(statusCode: number, body: any) {
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
    if (!item[field]) {
      errors.push(`${field} is required`);
    }
  }
  return errors;
}

function getRequiredFields(tableIndex: string): string[] {
  const fieldMap: Record<string, string[]> = {
    '0': ['storeCode', 'storeName', 'storeCategory', 'prefecture', 'city', 'transactionStartDate', 'transactionStatus', 'activeFlag', 'creatorId', 'updaterId'],
    '1': ['storeId', 'customerName', 'productName', 'category', 'capacityMl', 'remainingMl', 'remainingPercent', 'keepStartDate', 'status', 'creator'],
    '2': ['memberId', 'storeId', 'visitDateTime', 'keepBottleUsedFlag', 'newBottleOrderFlag', 'creator'],
    '3': ['storeId', 'keepBottleId', 'memberId', 'consumptionDateTime', 'consumptionAmount', 'remainingAmount', 'completedFlag', 'creator'],
    '4': ['storeId', 'productCategory', 'forecastPeriodStart', 'forecastPeriodEnd', 'forecastDemand', 'confidenceLevel', 'seasonalFactorFlag', 'eventFactorFlag', 'recommendedPurchaseAmount', 'creator'],
    '5': ['storeId', 'aggregateYearMonth', 'productCategory', 'newKeepBottles', 'completedBottles', 'totalConsumption', 'visitCount', 'activeMemberCount', 'averageConsumption', 'creator'],
    '6': ['analysisYear', 'analysisMonth', 'alcoholCategory', 'regionCode', 'baseConsumption', 'actualConsumption', 'seasonalVariationIndex', 'eventInfluenceFlag', 'creator'],
    '7': ['storeId', 'productCode', 'productName', 'planPeriodStart', 'planPeriodEnd', 'currentStock', 'forecastDemand', 'safetyStock', 'plannedReplenishment', 'scheduledReplenishmentDate', 'planStatus', 'priority', 'creator'],
    '8': ['storeId', 'productCode', 'productName', 'scheduledDeliveryDate', 'scheduledQuantity', 'deliveryStatus', 'creator'],
    '9': ['routeName', 'driverIdAssigned', 'vehicleIdAssigned', 'startLocation', 'endLocation', 'estimatedDuration', 'totalDistance', 'maxCapacity', 'deliveryDays', 'startTime', 'activeFlag', 'creator'],
    '10': ['loginId', 'passwordHash', 'userName', 'email', 'permissionLevel', 'organization', 'accountStatus', 'creator']
  };
  return fieldMap[tableIndex] || [];
}

export const handler = async (event: any) => {
  try {
    const method = event.httpMethod;
    const path = event.path;
    const pathSegments = path.split('/').filter(Boolean);
    
    if (method === 'OPTIONS') {
      return createResponse(200, {});
    }

    let user: User;
    try {
      user = extractUserFromEvent(event);
    } catch (error) {
      return createResponse(401, { error: 'Unauthorized' });
    }

    if (pathSegments[0] === 'resources') {
      if (!hasPermission(user, 'resources', 'read')) {
        return createResponse(403, { error: 'Forbidden' });
      }
      
      const resources = Object.entries(tableConfigs).map(([index, config]) => ({
        index,
        name: config.name,
        displayName: config.displayName,
        primaryKey: config.pk
      }));
      
      return createResponse(200, { resources });
    }

    if (pathSegments[0] === 'api' && pathSegments[1]) {
      const tableIndex = pathSegments[1];
      const config = tableConfigs[tableIndex as keyof typeof tableConfigs];
      
      if (!config) {
        return createResponse(404, { error: 'Table not found' });
      }

      const isBulkEndpoint = pathSegments[2] === 'bulk';
      const resourceId = pathSegments[2] && !isBulkEndpoint ? pathSegments[2] : null;

      if (method === 'GET') {
        if (!hasPermission(user, config.name, 'read')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        if (resourceId) {
          const result = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: { [config.pk]: resourceId }
          }));
          
          if (!result.Item) {
            return createResponse(404, { error: 'Item not found' });
          }
          
          return createResponse(200, result.Item);
        } else {
          const result = await docClient.send(new ScanCommand({
            TableName: TABLE_NAME,
            FilterExpression: 'attribute_exists(#pk)',
            ExpressionAttributeNames: { '#pk': config.pk }
          }));
          
          return createResponse(200, { items: result.Items || [] });
        }
      }

      if (method === 'POST') {
        if (isBulkEndpoint) {
          if (!hasPermission(user, config.name, 'bulk')) {
            return createResponse(403, { error: 'Forbidden' });
          }

          const body = JSON.parse(event.body || '{}');
          const items = body.items || [];
          
          if (!Array.isArray(items)) {
            return createResponse(400, { error: 'Items must be an array' });
          }

          let imported = 0;
          let failed = 0;
          const errors: string[] = [];

          for (let i = 0; i < items.length; i += 25) {
            const batch = items.slice(i, i + 25);
            const writeRequests = [];

            for (const item of batch) {
              const validationErrors = validateRequired(item, getRequiredFields(tableIndex));
              if (validationErrors.length > 0) {
                failed++;
                errors.push(`Item ${i + batch.indexOf(item)}: ${validationErrors.join(', ')}`);
                continue;
              }

              const now = new Date().toISOString();
              const enrichedItem = {
                ...item,
                [config.pk]: item[config.pk] || randomUUID(),
                createdAt: now,
                updatedAt: now
              };

              writeRequests.push({
                PutRequest: { Item: enrichedItem }
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
            imported,
            failed,
            totalItems: items.length
          });

          return createResponse(200, { imported, failed, errors });
        } else {
          if (!hasPermission(user, config.name, 'create')) {
            return createResponse(403, { error: 'Forbidden' });
          }

          const body = JSON.parse(event.body || '{}');
          const validationErrors = validateRequired(body, getRequiredFields(tableIndex));
          
          if (validationErrors.length > 0) {
            return createResponse(400, { error: 'Validation failed', details: validationErrors });
          }

          const now = new Date().toISOString();
          const item = {
            ...body,
            [config.pk]: body[config.pk] || randomUUID(),
            createdAt: now,
            updatedAt: now
          };

          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: item
          }));

          await createAuditLog(user, 'CREATE', config.name, { itemId: item[config.pk] });

          return createResponse(201, item);
        }
      }

      if (method === 'PUT' && resourceId) {
        if (!hasPermission(user, config.name, 'update')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        const body = JSON.parse(event.body || '{}');
        const validationErrors = validateRequired(body, getRequiredFields(tableIndex));
        
        if (validationErrors.length > 0) {
          return createResponse(400, { error: 'Validation failed', details: validationErrors });
        }

        const existing = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: { [config.pk]: resourceId }
        }));

        if (!existing.Item) {
          return createResponse(404, { error: 'Item not found' });
        }

        const item = {
          ...body,
          [config.pk]: resourceId,
          createdAt: existing.Item.createdAt,
          updatedAt: new Date().toISOString()
        };

        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: item
        }));

        await createAuditLog(user, 'UPDATE', config.name, { itemId: resourceId });

        return createResponse(200, item);
      }

      if (method === 'DELETE' && resourceId) {
        if (!hasPermission(user, config.name, 'delete')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        const existing = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: { [config.pk]: resourceId }
        }));

        if (!existing.Item) {
          return createResponse(404, { error: 'Item not found' });
        }

        await docClient.send(new DeleteCommand({
          TableName: TABLE_NAME,
          Key: { [config.pk]: resourceId }
        }));

        await createAuditLog(user, 'DELETE', config.name, { itemId: resourceId });

        return createResponse(200, { message: 'Item deleted successfully' });
      }
    }

    return createResponse(404, { error: 'Endpoint not found' });
  } catch (error) {
    console.error('Error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};