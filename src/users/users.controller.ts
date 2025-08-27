import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { PrismaService } from '../prisma/prisma.service';

@Controller('users')
export class UsersController {
  constructor(private prisma: PrismaService) {}

  @UseGuards(AuthGuard('jwt'))
  @Get('contacts')
  async getContacts(@Req() req: any) {
    const userId = req.user.sub as string;
    const contacts = await this.prisma.contact.findMany({
      where: { ownerId: userId },
      include: {
        contact: {
          select: { id: true, username: true, email: true, status: true },
        },
      },
      orderBy: { lastCallAt: 'desc' },
    });
    return contacts.map((c) => ({
      id: c.contact.id,
      username: c.contact.username,
      email: c.contact.email,
      status: c.contact.status,
      lastCallAt: c.lastCallAt,
    }));
  }
}
