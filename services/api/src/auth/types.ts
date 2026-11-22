export type AuthContext = {
  userId: string;
  sessionId: string;
  deviceId: string;
  clientType: 'mobile' | 'web';
};
