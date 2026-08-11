import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { success } from '../../shared/http.js';
import { confirmConsumption, getConsumptionPreview, type BatchSelections } from './service.js';

export async function registerConsumptionRoutes(app: FastifyInstance, database: PrismaClient): Promise<void> {
  app.post<{Params:{id:string};Body:{recordVersion:number;selections?:BatchSelections}}>('/api/v1/records/:id/consumption-preview',async(request)=>success(await getConsumptionPreview(database,request.params.id,request.body.recordVersion,request.body.selections)));
  app.post<{Params:{id:string};Body:{recordVersion:number;previewToken:string;operationId:string;selections?:BatchSelections}}>('/api/v1/records/:id/confirm-consumption',async(request)=>success(await confirmConsumption(database,{recordId:request.params.id,...request.body})));
}
