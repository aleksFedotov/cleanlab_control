// R10: единая карта «мутация → префиксы инвалидации». useApiMutation больше
// не принимает invalidate: префиксы берутся отсюда по имени метода.
// TypeScript — страховка exhaustiveness: метод, которого нет в ключах, не скомпилируется.
import { OPERATIONAL_PREFIXES } from '@/lib/query-keys';

const OPERATIONAL = OPERATIONAL_PREFIXES;
const REFS_AND_OPERATIONAL = ['refs', ...OPERATIONAL_PREFIXES];
const PAY = ['payroll', 'payRates', 'myPayroll'];

export const MUTATION_INVALIDATES = {
  // --- operational ---
  startWash: OPERATIONAL, completeWash: OPERATIONAL, cancelWash: OPERATIONAL,
  deferWash: OPERATIONAL, deleteWash: OPERATIONAL, editWashData: OPERATIONAL,
  editManualClean: OPERATIONAL,
  addUnplannedWash: OPERATIONAL, addManualClean: OPERATIONAL,
  confirmStorageCheck: OPERATIONAL, markIssued: OPERATIONAL, updateIssueDate: OPERATIONAL,
  closeShift: OPERATIONAL,
  driverAction: OPERATIONAL, correctVisit: OPERATIONAL, setVisitLiftFloor: OPERATIONAL,
  driverReturnClean: OPERATIONAL, driverTakeAllClean: OPERATIONAL, driverTakeClean: OPERATIONAL,
  driverHandover: OPERATIONAL,
  addDeliveryVisit: OPERATIONAL, removeDeliveryVisit: OPERATIONAL, setPickupOnly: OPERATIONAL,
  addWeekCard: OPERATIONAL, moveWeekCard: OPERATIONAL, removeWeekCard: OPERATIONAL,
  // --- refs (+operational) ---
  saveItemType: REFS_AND_OPERATIONAL, deleteItemType: REFS_AND_OPERATIONAL,
  saveClient: REFS_AND_OPERATIONAL, deleteClient: REFS_AND_OPERATIONAL,
  purgeClient: REFS_AND_OPERATIONAL,
  saveClientItemBilling: ['clientItemBilling', ...OPERATIONAL_PREFIXES],
  // --- точечные массивы ---
  setWorkHours: ['workHours'],
  savePayRate: PAY,
  savePaySettings: [...PAY, 'paySettings'],
  savePayAdjustment: ['payroll', 'myPayroll', 'payAdjustments'],
  deletePayAdjustment: ['payroll', 'myPayroll', 'payAdjustments'],
  addExtraWork: ['payroll', 'myPayroll', 'extraWorks'],
  editExtraWork: ['payroll', 'myPayroll', 'extraWorks'],
  deleteExtraWork: ['payroll', 'myPayroll', 'extraWorks'],
  saveBillingItem: ['billingItems', 'tariffs'],
  deleteBillingItem: ['billingItems', 'tariffs'],
  saveTariff: ['tariffs'],
  createUser: ['users'], updateUser: ['users'], deactivateUser: ['users'],
  reactivateUser: ['users'], deleteUser: ['users'],
  createLaundry: ['laundries'], updateLaundry: ['laundries'], deactivateLaundry: ['laundries'],
  // --- без инвалидации ---
  rememberClientItemType: [], resetUserPassword: [], makeTelegramBindCode: [],
} as const;

export type MutationMethod = keyof typeof MUTATION_INVALIDATES;
