import { Module } from '@nestjs/common';
import { HostNotificationsService } from './host-notifications.service';

@Module({
  providers: [HostNotificationsService],
  exports: [HostNotificationsService],
})
export class NotificationsModule {}
