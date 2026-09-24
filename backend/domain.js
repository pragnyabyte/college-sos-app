export const categories = [
    { id: 'medical', name: 'Medical Emergency', icon: 'MED', priority: 'CRITICAL', primaryDepartmentId: 'DEPT_MEDICAL', departmentIds: ['DEPT_MEDICAL'], restricted: false, examples: ['Injury', 'Sudden illness', 'Breathing problem'] },
    { id: 'security', name: 'Safety / Security', icon: 'SEC', priority: 'HIGH', primaryDepartmentId: 'DEPT_SECURITY', departmentIds: ['DEPT_SECURITY'], restricted: false, examples: ['Fight', 'Intruder', 'Physical danger'] },
    { id: 'fire', name: 'Fire Emergency', icon: 'FIRE', priority: 'CRITICAL', primaryDepartmentId: 'DEPT_FIRE', departmentIds: ['DEPT_FIRE', 'DEPT_SECURITY', 'DEPT_ADMIN'], restricted: false, examples: ['Fire', 'Smoke', 'Burning smell'] },
    { id: 'harassment', name: 'Harassment / Threat', icon: 'SAFE', priority: 'HIGH', primaryDepartmentId: 'DEPT_WELFARE', departmentIds: ['DEPT_WELFARE', 'DEPT_SECURITY'], restricted: true, examples: ['Threat', 'Harassment', 'Bullying'] },
    { id: 'electrical', name: 'Electrical Emergency', icon: 'ELEC', priority: 'HIGH', primaryDepartmentId: 'DEPT_ELECTRICAL', departmentIds: ['DEPT_ELECTRICAL'], restricted: false, examples: ['Electric shock', 'Exposed wire', 'Electrical fire'] },
    { id: 'infrastructure', name: 'Infrastructure Emergency', icon: 'BLDG', priority: 'HIGH', primaryDepartmentId: 'DEPT_MAINTENANCE', departmentIds: ['DEPT_MAINTENANCE'], restricted: false, examples: ['Structural damage', 'Water leakage', 'Unsafe condition'] },
    { id: 'trapped', name: 'Locked / Trapped', icon: 'LOCK', priority: 'HIGH', primaryDepartmentId: 'DEPT_SECURITY', departmentIds: ['DEPT_SECURITY', 'DEPT_MAINTENANCE'], restricted: false, examples: ['Locked in room', 'Elevator issue', 'Unable to exit'] },
    { id: 'other', name: 'Other Emergency', icon: 'SOS', priority: 'MEDIUM', primaryDepartmentId: 'DEPT_ADMIN', departmentIds: ['DEPT_ADMIN'], restricted: false, examples: ['Other urgent situation'] }
];
export const transitions = {
    SOS_SENT: ['DEPARTMENT_NOTIFIED', 'CANCELLED'], DEPARTMENT_NOTIFIED: ['ACCEPTED', 'CANCELLED', 'REJECTED', 'DUPLICATE'], ACCEPTED: ['RESPONDING', 'CANCELLED'], RESPONDING: ['ARRIVED'], ARRIVED: ['RESOLVED'], RESOLVED: ['REOPENED'], CANCELLED: [], REJECTED: [], DUPLICATE: [], REOPENED: ['ACCEPTED', 'RESPONDING']
};
export function canTransition(from, to) { return transitions[from]?.includes(to) ?? false; }
export function validateLocation(v) {
    if (!v || typeof v !== 'object')
        throw new Error('Location is required');
    const source = v.source === 'GPS' ? 'GPS' : 'MANUAL';
    for (const f of ['building', 'floor', 'room'])
        if (typeof v[f] !== 'string' || v[f].trim().length > 100)
            throw new Error(`Invalid ${f}`);
    const lat = v.latitude == null ? null : Number(v.latitude), lng = v.longitude == null ? null : Number(v.longitude), accuracy = v.accuracy == null ? null : Number(v.accuracy);
    if (lat !== null && (lat < -90 || lat > 90) || lng !== null && (lng < -180 || lng > 180) || accuracy !== null && accuracy < 0)
        throw new Error('Invalid GPS coordinates');
    return { building: v.building.trim(), floor: v.floor.trim(), room: v.room.trim(), area: String(v.area || '').slice(0, 100), latitude: lat, longitude: lng, accuracy, source };
}
