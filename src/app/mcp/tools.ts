import type { Services } from '../ipc.ts';

const descriptions: Record<string, string> = {
  analytics: 'Import owner-provided CSV retention data, list pending weight proposals, accept or reject them; only accept changes active weights',
  project: 'Quản lý dự án', reference: 'Quản lý tham chiếu', bible: 'Cập nhật Bible',
  script: 'Soạn và duyệt kịch bản', storyboard: 'Tạo và duyệt storyboard', render: 'Điều phối render',
  take: 'Xem và chọn take', edit: 'Dựng và xuất video', audio: 'Dựng âm thanh',
  export: 'Xuất gói xuất bản', account: 'Quản lý tài khoản, không cung cấp thông tin đăng nhập',
  credit: 'Theo dõi credit', queue: 'Xem hàng đợi',
};
export function createMcpTools(services: Services) {
  const commands = new Map(services.listCommands().map(command => [command.name.replaceAll('.', '_'), command]));
  return {
    list: () => [...commands].map(([name, command]) => ({ name,
      description: `${descriptions[command.name.split('.')[0]] ?? 'Lệnh dịch vụ'}: ${command.name}`,
      inputSchema: command.inputSchema })),
    async call(name: string, args: unknown) {
      const command = commands.get(name);
      if (!command || !args || typeof args !== 'object' || Array.isArray(args)) return undefined;
      try {
        const result = await services.execute(command.name, args);
        return { isError: !result.ok, content: [{ type: 'text', text: JSON.stringify(result.ok ? result.data : result.error) }] };
      } catch {
        return { isError: true, content: [{ type: 'text', text: 'Không thể hoàn tất lệnh dịch vụ' }] };
      }
    },
  };
}
