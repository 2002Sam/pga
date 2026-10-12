"""past conversations remember which model handled them and in which project

Revision ID: b3d5f7a9c1e2
Revises: a7c3e9f1b2d4
Create Date: 2026-10-12 18:30:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = 'b3d5f7a9c1e2'
down_revision: Union[str, Sequence[str], None] = 'a7c3e9f1b2d4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('agent_conversations', sa.Column('model', sa.String(length=80), nullable=True))
    op.add_column('agent_conversations', sa.Column('project', sa.String(length=200), nullable=True))


def downgrade() -> None:
    op.drop_column('agent_conversations', 'project')
    op.drop_column('agent_conversations', 'model')
