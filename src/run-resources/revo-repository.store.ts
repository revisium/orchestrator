import { Injectable } from '@nestjs/common';
import { Prisma } from '../__generated__/client/client.js';
import type { RevoPrismaService } from '../storage/revo-prisma.service.js';

export type RevoRepositoryConfiguration = {
  id: string;
  projectId: string;
  name: string;
  remoteUrl: string | null;
  localPath: string | null;
  defaultBranch: string | null;
};

export type RevoRepositoryProject = { id: string; name: string; slug: string };
export type ResolvedRepositoryLaunch = { repository: RevoRepositoryConfiguration; project: RevoRepositoryProject };

export class RevoRepositoryNotFoundError extends Error {
  constructor(message = 'repository not found') { super(message); this.name = 'RevoRepositoryNotFoundError'; }
}

export class RevoRepositoryProjectIneligibleError extends Error {
  constructor(message = 'repository project is ineligible') { super(message); this.name = 'RevoRepositoryProjectIneligibleError'; }
}

const selectRepository = { id: true, projectId: true, name: true, remoteUrl: true, localPath: true, defaultBranch: true } as const;
const selectProject = { id: true, name: true, slug: true, status: true, deletedAt: true } as const;

@Injectable()
export class RevoRepositoryStore {
  constructor(private readonly prisma: RevoPrismaService) {}

  async create(input: { projectId: string; name: string; remoteUrl?: string; localPath?: string; defaultBranch?: string }): Promise<RevoRepositoryConfiguration> {
    return this.prisma.revoRepository.create({ data: input, select: selectRepository });
  }

  async get(id: string): Promise<RevoRepositoryConfiguration> {
    const repository = await this.prisma.revoRepository.findUnique({ where: { id }, select: selectRepository });
    if (!repository) throw new RevoRepositoryNotFoundError();
    return repository;
  }

  async update(id: string, input: { name?: string; remoteUrl?: string | null; localPath?: string | null; defaultBranch?: string | null }): Promise<RevoRepositoryConfiguration> {
    try {
      return await this.prisma.revoRepository.update({ where: { id }, data: input, select: selectRepository });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') throw new RevoRepositoryNotFoundError();
      throw error;
    }
  }

  async delete(id: string): Promise<void> {
    try {
      await this.prisma.revoRepository.delete({ where: { id } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') throw new RevoRepositoryNotFoundError();
      throw error;
    }
  }

  async resolveForLaunch(id: string): Promise<ResolvedRepositoryLaunch> {
    const repository = await this.prisma.revoRepository.findUnique({ where: { id }, select: { ...selectRepository, project: { select: selectProject } } });
    if (!repository) throw new RevoRepositoryNotFoundError();
    const { project, ...configuration } = repository;
    if (project.status !== 'ACTIVE' || project.deletedAt !== null) throw new RevoRepositoryProjectIneligibleError();
    return { repository: configuration, project: { id: project.id, name: project.name, slug: project.slug } };
  }
}
