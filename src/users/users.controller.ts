import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { PrismaService } from '../prisma/prisma.service';

@Controller('users')
export class UsersController {
  constructor(private prisma: PrismaService) {}

  @UseGuards(AuthGuard('jwt'))
  @Get('contacts')
  async getContacts(@Req() req: { user: { sub: string } }) {
    const userId = req.user.sub;
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

  /**
   * Roster endpoint: lightweight directory of other users (not yet contacted) so user can initiate first call.
   * Excludes self and limits to recent users for performance; extend with pagination later.
   */
  @UseGuards(AuthGuard('jwt'))
  @Get('roster')
  async getRoster(@Req() req: { user: { sub: string } }) {
    const userId = req.user.sub;
    // Fetch up to 25 other users ordered by recent activity (updatedAt)
    const others = await this.prisma.user.findMany({
      where: { id: { not: userId } },
      select: {
        id: true,
        username: true,
        email: true,
        status: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
      take: 25,
    });
    return others.map((u) => ({
      id: u.id,
      username: u.username,
      email: u.email,
      status: u.status,
      lastCallAt: null, // not yet contacted
    }));
  }
}
