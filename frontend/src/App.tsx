import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { Spin } from 'antd'
import { useAuth } from './auth'
import AppLayout from './components/AppLayout'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import OrderDistributionDetail from './pages/OrderDistributionDetail'
import DailySummary from './pages/DailySummary'
import Forecast from './pages/Forecast'
import Customers from './pages/Customers'
import CustomerDetail from './pages/CustomerDetail'
import Orders from './pages/Orders'
import Boats from './pages/Boats'
import OrderForm from './pages/OrderForm'
import OrderDetail from './pages/OrderDetail'
import CatalogSettings from './pages/CatalogSettings'
import Users from './pages/Users'

function RequireAuth({ children }: { children: JSX.Element }) {
  const { user, loading } = useAuth()
  if (loading) {
    return (
      <div style={{ textAlign: 'center', marginTop: 160 }}>
        <Spin size="large" />
      </div>
    )
  }
  if (!user) return <Navigate to="/login" replace />
  return children
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/"
          element={
            <RequireAuth>
              <AppLayout />
            </RequireAuth>
          }
        >
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="dashboard/order-distribution" element={<OrderDistributionDetail />} />
          <Route path="dashboard/daily-summary" element={<DailySummary />} />
          <Route path="dashboard/forecast" element={<Forecast />} />
          <Route path="orders" element={<Orders />} />
          <Route path="orders/new" element={<OrderForm />} />
          <Route path="orders/:id" element={<OrderDetail />} />
          <Route path="orders/:id/edit" element={<OrderForm />} />
          <Route path="boats" element={<Boats />} />
          <Route path="customers" element={<Customers />} />
          <Route path="customers/:id" element={<CustomerDetail />} />
          <Route path="users" element={<Users />} />
          <Route path="settings" element={<CatalogSettings />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
