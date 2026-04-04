'use client';

import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

interface Order {
  id: string;
  orderNumber: string;
  status: string;
  total: number;
  createdAt: string;
  items: Array<{ description: string; quantity: number; unitPrice: number }>;
}

const statusVariant: Record<string, 'default' | 'success' | 'warning' | 'info' | 'error'> = {
  PENDING: 'warning',
  CONFIRMED: 'info',
  IN_PRODUCTION: 'info',
  READY: 'success',
  SHIPPED: 'success',
  DELIVERED: 'success',
  CANCELLED: 'error',
};

export default function CustomerOrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get<any>('/orders/customer/my-orders')
      .then(data => setOrders(Array.isArray(data) ? data : data.data || []))
      .catch(() => setOrders([]))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="text-gray-500 dark:text-gray-400">Loading orders...</div>;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold dark:text-gray-100">My Orders</h1>

      {orders.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-gray-500 dark:text-gray-400">
            No orders yet.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {orders.map(order => (
            <Card key={order.id}>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">{order.orderNumber}</CardTitle>
                  <Badge variant={statusVariant[order.status] || 'default'}>
                    {order.status.replace(/_/g, ' ')}
                  </Badge>
                </div>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {new Date(order.createdAt).toLocaleDateString()}
                </p>
              </CardHeader>
              <CardContent>
                {order.items?.map((item, i) => (
                  <div key={i} className="flex justify-between text-sm py-1">
                    <span className="dark:text-gray-300">{item.description} x{item.quantity}</span>
                  </div>
                ))}
                <div className="flex justify-between font-semibold text-sm mt-2 pt-2 border-t dark:border-gray-700">
                  <span className="dark:text-gray-200">Total</span>
                  <span className="dark:text-gray-200">{order.total?.toFixed(3)} OMR</span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
