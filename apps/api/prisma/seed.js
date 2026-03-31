"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const bcrypt = __importStar(require("bcrypt"));
const prisma = new client_1.PrismaClient();
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
            role: client_1.Role.ADMIN,
        },
    });
    console.log('Created admin user:', admin.email);
    // Create default materials
    const materials = [
        { name: 'PLA White', type: client_1.MaterialType.PLA, color: 'White', brand: 'eSUN', costPerGram: 0.025, density: 1.24 },
        { name: 'PLA Black', type: client_1.MaterialType.PLA, color: 'Black', brand: 'eSUN', costPerGram: 0.025, density: 1.24 },
        { name: 'PETG White', type: client_1.MaterialType.PETG, color: 'White', brand: 'eSUN', costPerGram: 0.030, density: 1.27 },
        { name: 'PETG Black', type: client_1.MaterialType.PETG, color: 'Black', brand: 'eSUN', costPerGram: 0.030, density: 1.27 },
        { name: 'TPU Black', type: client_1.MaterialType.TPU, color: 'Black', brand: 'eSUN', costPerGram: 0.045, density: 1.21 },
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
//# sourceMappingURL=seed.js.map