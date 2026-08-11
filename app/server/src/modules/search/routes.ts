import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { success } from '../../shared/http.js';
export async function registerSearchRoutes(app: FastifyInstance, db: PrismaClient) {
  app.get<{ Querystring: { q?: string } }>('/api/v1/search', async (r) => {
    const q = r.query.q?.trim();
    if (!q) return success({ recipes: [], ingredients: [], stores: [], records: [] });
    const [recipes, ingredients, stores, records] = await Promise.all([
      db.recipe.findMany({
        where: {
          deletedAt: null,
          OR: [
            { name: { contains: q } },
            { ingredientsText: { contains: q } },
            { notes: { contains: q } },
            { ingredients: { some: { ingredientNameSnapshot: { contains: q } } } }
          ]
        },
        take: 20
      }),
      db.ingredient.findMany({
        where: {
          deletedAt: null,
          OR: [{ name: { contains: q } }, { category: { contains: q } }, { notes: { contains: q } }]
        },
        take: 20
      }),
      db.store.findMany({
        where: {
          deletedAt: null,
          OR: [
            { name: { contains: q } },
            { cuisine: { contains: q } },
            { recommendedDishes: { contains: q } },
            { tagsText: { contains: q } },
            { notes: { contains: q } }
          ]
        },
        take: 20
      }),
      db.mealRecord.findMany({
        where: {
          deletedAt: null,
          OR: [
            { notes: { contains: q } },
            {
              items: {
                some: {
                  OR: [
                    { customName: { contains: q } },
                    { recipe: { name: { contains: q } } },
                    { store: { name: { contains: q } } }
                  ]
                }
              }
            }
          ]
        },
        include: { items: true },
        take: 20
      })
    ]);
    return success({ recipes, ingredients, stores, records });
  });
  app.get('/api/v1/favorites', async () => {
    const [recipes, stores, records] = await Promise.all([
      db.recipe.findMany({ where: { deletedAt: null, favorite: true }, orderBy: { updatedAt: 'desc' } }),
      db.store.findMany({ where: { deletedAt: null, favorite: true }, orderBy: { updatedAt: 'desc' } }),
      db.mealRecord.findMany({
        where: { deletedAt: null, favorite: true },
        include: { items: true },
        orderBy: { recordDate: 'desc' }
      })
    ]);
    return success({ recipes, stores, records });
  });
}
