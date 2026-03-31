import { PrismaClient, Role, MaterialType, PrinterConnectionType } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  // Create admin user
  const adminPassword = await bcrypt.hash('admin123', 10);
  const admin = await prisma.user.upsert({
    where: { email: 'admin@printforge.local' },
    update: {},
    create: {
      email: 'admin@printforge.local',
      passwordHash: adminPassword,
      name: 'Admin',
      role: Role.ADMIN,
    },
  });
  console.log('Created admin user:', admin.email);

  // Create default materials
  const materials = [
    { name: 'PLA White', type: MaterialType.PLA, color: 'White', brand: 'eSUN', costPerGram: 0.025, density: 1.24 },
    { name: 'PLA Black', type: MaterialType.PLA, color: 'Black', brand: 'eSUN', costPerGram: 0.025, density: 1.24 },
    { name: 'PETG White', type: MaterialType.PETG, color: 'White', brand: 'eSUN', costPerGram: 0.030, density: 1.27 },
    { name: 'PETG Black', type: MaterialType.PETG, color: 'Black', brand: 'eSUN', costPerGram: 0.030, density: 1.27 },
    { name: 'TPU Black', type: MaterialType.TPU, color: 'Black', brand: 'eSUN', costPerGram: 0.045, density: 1.21 },
  ];

  for (const mat of materials) {
    await prisma.material.create({ data: mat });
  }
  console.log('Created', materials.length, 'default materials');

  // Create default system settings
  const settings = [
    { key: 'currency', value: 'OMR' },
    { key: 'tax_rate', value: '0' },
    { key: 'overhead_percent', value: '15' },
    { key: 'purge_waste_grams', value: '5' },
    { key: 'default_infill_percent', value: '20' },
    { key: 'company_name', value: 'My Print Farm' },
    { key: 'company_address', value: '' },
    { key: 'company_logo_path', value: '' },
    { key: 'default_margin_percent', value: '40' },
  ];

  for (const setting of settings) {
    await prisma.systemSetting.upsert({
      where: { key: setting.key },
      update: { value: setting.value },
      create: setting,
    });
  }
  console.log('Created', settings.length, 'default settings');

  // Create default expense categories
  const categories = ['Filament', 'Equipment', 'Electricity', 'Rent', 'Software', 'Shipping', 'Marketing', 'Other'];
  for (const name of categories) {
    await prisma.expenseCategory.upsert({
      where: { name },
      update: {},
      create: { name },
    });
  }
  console.log('Created', categories.length, 'expense categories');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
