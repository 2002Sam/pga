"""folders belong to motivations: projects.aim_id

Revision ID: f7b9d1e3a5c6
Revises: e6a8c0d2f4b5
Create Date: 2026-10-14 17:10:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = 'f7b9d1e3a5c6'
down_revision: Union[str, Sequence[str], None] = 'e6a8c0d2f4b5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('projects', sa.Column('aim_id', sa.Uuid(), nullable=True))
    op.create_foreign_key(op.f('fk_projects_aim_id_aims'), 'projects', 'aims', ['aim_id'], ['id'], ondelete='SET NULL')


def downgrade() -> None:
    op.drop_constraint(op.f('fk_projects_aim_id_aims'), 'projects', type_='foreignkey')
    op.drop_column('projects', 'aim_id')
