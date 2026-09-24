import { categories } from '../domain.js';

export const id = '003_remove_category_emojis';

export async function up(db) {
  const operations = categories.map(c => ({
    updateOne: {
      filter: { id: c.id },
      update: {
        $set: {
          icon: c.icon,
          name: c.name,
          priority: c.priority,
          updated_at: new Date().toISOString()
        }
      }
    }
  }));

  if (operations.length) {
    await db.collection('categories').bulkWrite(operations);
  }
}
