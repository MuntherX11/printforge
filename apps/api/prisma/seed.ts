import { PrismaClient, Role, MaterialType, PrinterConnectionType } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  // Create admin user (credentials from environment variables)
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@printforge.local';
  const adminPass = process.env.ADMIN_PASSWORD;
  if (!adminPass) {
    console.error('ERROR: ADMIN_PASSWORD environment variable is required for seeding.');
    console.error('Usage: ADMIN_PASSWORD=your_secure_password npx prisma db seed');
    process.exit(1);
  }
  const adminPassword = await bcrypt.hash(adminPass, 10);
  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      email: adminEmail,
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
    const existing = await prisma.material.findFirst({
      where: { name: mat.name, type: mat.type, color: mat.color },
    });
    if (!existing) {
      await prisma.material.create({ data: mat });
    }
  }
  console.log('Seeded default materials (skipped existing)');

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
