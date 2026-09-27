export const id = '004_students_collection';

export async function up(db) {
  try {
    await db.collection('students').createIndex({ regdNo: 1 }, { unique: true, name: 'student_regd_unique' });
    console.log('[Migration:004] Created unique index on students collection (regdNo)');
  } catch (err) {
    console.warn('[Migration:004] Note on students index:', err.message);
  }
}
