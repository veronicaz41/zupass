import { Input } from "@chakra-ui/react";
import { FeedIssuanceOptions } from "@pcd/passport-interface";
import { ChangeEvent } from "react";
import styled from "styled-components";

interface FeedOptionsProps {
  feedOptions: FeedIssuanceOptions;
  setFeedOptions: (options: FeedIssuanceOptions) => void;
}

export const FeedOptions: React.FC<FeedOptionsProps> = ({
  feedOptions,
  setFeedOptions
}) => {
  const handleChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const { name, value } = event.target;
    setFeedOptions({
      ...feedOptions,
      [name]: value
    });
  };

  return (
    <FeedOptionsTable>
      <tbody>
        <tr>
          <td>
            <label htmlFor="feedId">Feed ID</label>
          </td>
          <td>
            <Input
              width="md"
              type="text"
              id="feedId"
              name="feedId"
              value={feedOptions.feedId}
              onChange={handleChange}
            />
          </td>
        </tr>
        <tr>
          <td>
            <label htmlFor="feedDisplayName">Feed Display Name</label>
          </td>
          <td>
            <Input
              width="md"
              type="text"
              id="feedDisplayName"
              name="feedDisplayName"
              value={feedOptions.feedDisplayName}
              onChange={handleChange}
            />
          </td>
        </tr>
        <tr>
          <td>
            <label htmlFor="feedDescription">Feed Description</label>
          </td>
          <td>
            <Input
              width="md"
              type="text"
              id="feedDescription"
              name="feedDescription"
              value={feedOptions.feedDescription}
              onChange={handleChange}
            />
          </td>
        </tr>
        <tr>
          <td>
            <label htmlFor="feedFolder">Feed Folder</label>
          </td>
          <td>
            <Input
              width="md"
              type="text"
              id="feedFolder"
              name="feedFolder"
              value={feedOptions.feedFolder}
              onChange={handleChange}
            />
          </td>
        </tr>
      </tbody>
    </FeedOptionsTable>
  );
};

const FeedOptionsTable = styled.table`
  tbody {
    tr {
      td:first-child {
        text-align: right;
        padding-right: 16px;
        width: 200px;
      }
    }
  }
`;