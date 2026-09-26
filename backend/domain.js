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
    if (!v || typeof v !== 'object') {
        v = {};
    }
    const building = v.building == null ? '' : String(v.building).trim();
    const floor = v.floor == null ? '' : String(v.floor).trim();
    const room = v.room == null ? '' : String(v.room).trim();
    const area = v.area == null ? (room || '') : String(v.area).trim();

    if (building.length > 100) throw new Error('Building name is too long');
    if (floor.length > 100) throw new Error('Floor name is too long');
    if (room.length > 100) throw new Error('Room name is too long');
    if (area.length > 100) throw new Error('Area name is too long');

    const lat = (v.latitude == null || v.latitude === '') ? null : Number(v.latitude);
    const lng = (v.longitude == null || v.longitude === '') ? null : Number(v.longitude);
    const accuracy = (v.accuracy == null || v.accuracy === '') ? null : Number(v.accuracy);

    if (lat !== null && (!Number.isFinite(lat) || lat < -90 || lat > 90))
        throw new Error('Invalid GPS coordinates');
    if (lng !== null && (!Number.isFinite(lng) || lng < -180 || lng > 180))
        throw new Error('Invalid GPS coordinates');
    if (accuracy !== null && (!Number.isFinite(accuracy) || accuracy < 0))
        throw new Error('Invalid GPS coordinates');

    let locationStatus = String(v.locationStatus || v.location_status || '').trim();
    if (!locationStatus) {
        locationStatus = (lat !== null && lng !== null) ? 'available' : 'unavailable';
    }

    let gpsTimestamp = v.gpsTimestamp || v.gps_timestamp || null;
    if (gpsTimestamp) {
        try {
            gpsTimestamp = new Date(gpsTimestamp).toISOString();
        } catch {
            gpsTimestamp = null;
        }
    } else if (lat !== null && lng !== null) {
        gpsTimestamp = new Date().toISOString();
    }

    const source = (v.source === 'GPS' || (lat !== null && lng !== null)) ? 'GPS' : 'MANUAL';

    return {
        building,
        floor,
        room,
        area,
        latitude: lat,
        longitude: lng,
        accuracy,
        locationStatus,
        location_status: locationStatus,
        gpsTimestamp,
        gps_timestamp: gpsTimestamp,
        source
    };
}
