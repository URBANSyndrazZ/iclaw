import { MessageCircle, Users, Settings } from 'lucide-react';

interface NavItem {
  path: string;
  icon: typeof MessageCircle;
  label: string;
  requiresBilling?: boolean;
  hideOnMobile?: boolean;
}

export const baseNavItems: NavItem[] = [
  { path: '/hr', icon: Users, label: 'HR 工作台' },
  { path: '/chat', icon: MessageCircle, label: 'HR 助手' },
  { path: '/settings', icon: Settings, label: '设置' },
];

export function filterNavItems(billingEnabled: boolean) {
  return baseNavItems.filter((item) => !item.requiresBilling || billingEnabled);
}
